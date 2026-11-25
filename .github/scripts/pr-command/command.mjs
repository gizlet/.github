// Pull-request slash commands: parsing and requester authorization.

const MAX_ARGS_LENGTH = 500;

// GitHub's legacy `permission` field maps maintain to write and triage to read.
const TRUSTED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

// The gizlet-bot GitHub App, which posts the triage comment. `[bot]` logins
// belong to GitHub Apps and cannot be taken by a user account.
export const TRIAGE_BOT = 'gizlet-bot[bot]';

// The head a triage comment was posted for, in a hidden marker.
const HEAD_MARKER = /<!--\s*gizlet-triage\s+head_sha=([0-9a-f]{40})\s*-->/;

/** The hidden marker triage adds to its comment, naming the head it was posted for. */
export function headMarker(headSha) {
  return `<!-- gizlet-triage head_sha=${headSha} -->`;
}

/** The head named by a triage comment's marker, or ''. */
export function markedHead(body) {
  return HEAD_MARKER.exec(String(body ?? ''))?.[1] ?? '';
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateCommand(command) {
  const value = String(command ?? '').trim();
  if (!/^\/[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`Invalid command ${JSON.stringify(command)}; use a slash and letters, digits, or hyphens, such as /test.`);
  }
  return value;
}

/**
 * Finds a line that starts with the command, outside code blocks, indented
 * code, and quotes. Text after the command on the same line becomes `args`.
 */
export function parseCommand(body, command) {
  const pattern = new RegExp(`^${escapeRegExp(validateCommand(command))}(?:\\s+(.*))?$`, 'i');
  const text = String(body ?? '').replace(/\r\n?/g, '\n');
  let fence = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^( {4}|\t)/.test(raw) || line.startsWith('>')) continue;
    const match = pattern.exec(line);
    if (match) {
      return { requested: true, args: (match[1] ?? '').trim().slice(0, MAX_ARGS_LENGTH) };
    }
  }
  return { requested: false, args: '' };
}

export function isTrustedPermission(permission) {
  return TRUSTED_PERMISSIONS.has(String(permission ?? '').toLowerCase());
}

export function isSameRepository(pr, owner, repo) {
  return pr.head?.repo?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase();
}

async function permissionOf(github, owner, repo, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return data.permission;
  } catch (error) {
    if (error.status === 404) return 'none';
    throw error;
  }
}

/**
 * Resolves a command from an `issue_comment` or `workflow_dispatch` event and
 * verifies its requester: a user with write access to the calling repository,
 * or the triage bot. A triage comment applies only to the head it names.
 * Sets `requested` and, when true, the pull-request step outputs.
 */
export async function resolvePullRequestCommand({
  github, context, core, command, requestedNumber = '', expectedHeadSha = '', allowForks = false, triageBot = TRIAGE_BOT,
}) {
  const { owner, repo } = context.repo;
  let commentId = '';
  const skip = async (reason) => {
    core.notice(reason);
    core.setOutput('requested', 'false');
    // Tell a commenter whose well-formed command was refused.
    if (commentId) {
      await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: Number(commentId), content: 'confused' })
        .catch((error) => core.warning(`Could not react to the comment: ${error.message}`));
    }
    return { requested: false, reason };
  };
  const quiet = (reason) => {
    core.info(reason);
    core.setOutput('requested', 'false');
    return { requested: false, reason };
  };

  let number;
  let actor;
  let args = '';
  let fromTriage = false;
  let expected = String(expectedHeadSha ?? '').trim();
  if (context.eventName === 'issue_comment') {
    const { action, issue, comment } = context.payload;
    if (action !== 'created') return quiet('Only newly created comments run commands.');
    if (!issue?.pull_request) return quiet('The comment is not on a pull request.');
    fromTriage = comment?.user?.type === 'Bot' && comment.user.login === triageBot;
    if (comment?.user?.type !== 'User' && !fromTriage) return quiet(`Only user accounts and ${triageBot} can run commands.`);
    const parsed = parseCommand(comment.body, command);
    if (!parsed.requested) return quiet(`The comment has no ${command} line.`);
    number = Number(issue.number);
    actor = comment.user.login;
    commentId = String(comment.id);
    args = fromTriage ? '' : parsed.args;
    if (fromTriage) {
      expected = markedHead(comment.body);
      if (!expected) return quiet(`The ${triageBot} comment names no head.`);
    }
  } else if (context.eventName === 'workflow_dispatch') {
    number = Number(String(requestedNumber ?? '').trim());
    actor = context.actor;
  } else {
    return quiet(`Unsupported event: ${context.eventName}.`);
  }
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('A positive pull request number is required.');
  }

  if (!fromTriage) {
    const permission = await permissionOf(github, owner, repo, actor);
    if (!isTrustedPermission(permission)) {
      return skip(`${actor} has ${permission} permission; write access is required to run ${command}.`);
    }
  }

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.state !== 'open') return skip(`Pull request #${number} is not open.`);
  if (expected && pr.head.sha !== expected) {
    return quiet(`Pull request #${number} moved from ${expected} to ${pr.head.sha}; the newer head has its own request.`);
  }
  if (!allowForks && !isSameRepository(pr, owner, repo)) {
    return skip(`Pull request #${number} comes from a fork; ${command} runs only for branches in ${owner}/${repo}.`);
  }

  const outputs = {
    requested: 'true',
    number: String(pr.number),
    head_sha: pr.head.sha,
    base_ref: pr.base.ref,
    comment_id: commentId,
    args,
    requester: actor,
  };
  for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);
  core.info(`${command} for #${pr.number} at ${pr.head.sha} requested by ${actor}.`);
  return { ...outputs, requested: true };
}
