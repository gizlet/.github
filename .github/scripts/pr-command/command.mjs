// Pull-request slash commands: parsing and requester authorization.

const MAX_ARGS_LENGTH = 500;

// GitHub's legacy `permission` field maps maintain to write and triage to read.
const TRUSTED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

// Dispatches created with a workflow's GITHUB_TOKEN, such as pr-auto-trigger.
// Only workflows running in the calling repository can create them.
export const AUTOMATION_ACTOR = 'github-actions[bot]';

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
 * verifies that its requester has write access to the calling repository.
 * Sets `requested` and, when true, the pull-request step outputs.
 */
export async function resolvePullRequestCommand({
  github, context, core, command, requestedNumber = '', expectedHeadSha = '', allowForks = false,
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
  if (context.eventName === 'issue_comment') {
    const { action, issue, comment } = context.payload;
    if (action !== 'created') return quiet('Only newly created comments run commands.');
    if (!issue?.pull_request) return quiet('The comment is not on a pull request.');
    if (comment?.user?.type !== 'User') return quiet('Only user accounts can run commands.');
    const parsed = parseCommand(comment.body, command);
    if (!parsed.requested) return quiet(`The comment has no ${command} line.`);
    number = Number(issue.number);
    actor = comment.user.login;
    commentId = String(comment.id);
    args = parsed.args;
  } else if (context.eventName === 'workflow_dispatch') {
    number = Number(String(requestedNumber ?? '').trim());
    actor = context.actor;
  } else {
    return quiet(`Unsupported event: ${context.eventName}.`);
  }
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('A positive pull request number is required.');
  }

  const automation = context.eventName === 'workflow_dispatch'
    && (actor === AUTOMATION_ACTOR || context.payload?.sender?.login === AUTOMATION_ACTOR);
  if (!automation) {
    const permission = await permissionOf(github, owner, repo, actor);
    if (!isTrustedPermission(permission)) {
      return skip(`${actor} has ${permission} permission; write access is required to run ${command}.`);
    }
  }

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.state !== 'open') return skip(`Pull request #${number} is not open.`);
  const expected = String(expectedHeadSha ?? '').trim();
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
