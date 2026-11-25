// Starts pull-request CI and review by dispatching the caller's workflows on
// the default branch for the pull request's current head:
// - pull_request_target (opened, reopened, synchronize, ready_for_review):
//   every mapped workflow, for an open, non-draft pull request whose branch is
//   in the repository. Only writers can push such branches.
// - issue_comment: the workflows of each slash command in a writer's comment,
//   such as `/test`, to run them again or for a draft.

import {
  isSameRepository, isTrustedPermission, parseCommand, validateCommand,
} from './command.mjs';

const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;

/**
 * Parses `/command=workflow.yml [workflow.yml ...]` entries separated by new
 * lines or commas into [{ command, workflows }].
 */
export function parseCommandMap(value) {
  const entries = [];
  for (const raw of String(value ?? '').split(/[\n,]/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\S+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid command mapping ${JSON.stringify(line)}; use /command=workflow.yml.`);
    const command = validateCommand(match[1]);
    const workflows = [...new Set(match[2].trim().split(/\s+/))];
    for (const workflow of workflows) {
      if (!WORKFLOW.test(workflow)) throw new Error(`Invalid workflow file name: ${workflow}`);
    }
    if (entries.some((entry) => entry.command.toLowerCase() === command.toLowerCase())) {
      throw new Error(`Duplicate command: ${command}`);
    }
    entries.push({ command, workflows });
  }
  if (!entries.length) throw new Error('At least one command mapping is required.');
  return entries;
}

const AUTO_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** Whether a pull-request event starts CI on its own; pure. */
export function decideAuto({ action, pr, owner, repo, eventHeadSha }) {
  if (!AUTO_ACTIONS.has(action)) return { dispatch: false, reason: `The ${action} event does not start CI.` };
  if (pr.state !== 'open') return { dispatch: false, reason: 'The pull request is not open.' };
  if (pr.head.sha !== eventHeadSha) return { dispatch: false, reason: `The head moved to ${pr.head.sha}; its own event starts CI.` };
  if (pr.draft) return { dispatch: false, reason: 'Draft pull requests start CI when marked ready, or with a command.' };
  if (!isSameRepository(pr, owner, repo)) return { dispatch: false, reason: 'Fork pull requests never start CI on their own.' };
  return { dispatch: true, reason: 'The head branch is in this repository.' };
}

async function dispatchAll({ github, core, owner, repo, number, headSha, workflows }) {
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  for (const workflow of workflows) {
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: workflow, ref: repository.default_branch,
      inputs: { pull_request_number: String(number), head_sha: headSha },
    });
    core.info(`Dispatched ${workflow} on ${repository.default_branch} for #${number} at ${headSha}.`);
  }
}

async function triagePullRequest({ github, context, core, commands }) {
  const { owner, repo } = context.repo;
  const number = Number(context.payload.pull_request.number);
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const decision = decideAuto({
    action: context.payload.action, pr, owner, repo, eventHeadSha: context.payload.pull_request.head.sha,
  });
  core.info(decision.reason);
  if (!decision.dispatch) {
    core.setOutput('dispatched', '');
    return { dispatched: [], reason: decision.reason };
  }
  const workflows = [...new Set(commands.flatMap((entry) => entry.workflows))];
  await dispatchAll({ github, core, owner, repo, number, headSha: pr.head.sha, workflows });
  core.setOutput('dispatched', workflows.join(','));
  return { dispatched: workflows, headSha: pr.head.sha };
}

export async function triage({ github, context, core, env = process.env }) {
  const commands = parseCommandMap(env.COMMANDS);
  if (context.eventName === 'pull_request_target') return triagePullRequest({ github, context, core, commands });
  if (context.eventName !== 'issue_comment') {
    throw new Error(`pr-triage must be called from pull_request_target or issue_comment, not ${context.eventName}.`);
  }
  const allowForks = env.ALLOW_FORKS === 'true';
  const { owner, repo } = context.repo;
  const { action, issue, comment } = context.payload;
  const done = (reason, extra = {}) => {
    core.info(reason);
    core.setOutput('dispatched', '');
    return { dispatched: [], reason, ...extra };
  };
  const react = (content) => github.rest.reactions.createForIssueComment({
    owner, repo, comment_id: Number(comment.id), content,
  }).catch((error) => core.warning(`Could not react to the comment: ${error.message}`));
  const refuse = async (reason) => {
    core.notice(reason);
    await react('confused');
    return done(reason, { refused: true });
  };

  if (action !== 'created') return done('Only newly created comments run commands.');
  if (!issue?.pull_request) return done('The comment is not on a pull request.');
  if (comment?.user?.type !== 'User') return done('Only user accounts can run commands.');
  const requested = commands.filter(({ command }) => parseCommand(comment.body, command).requested);
  if (!requested.length) return done('The comment has no command line.');
  const names = requested.map(({ command }) => command).join(', ');

  const actor = comment.user.login;
  let permission = 'none';
  try {
    ({ data: { permission } } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: actor }));
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!isTrustedPermission(permission)) {
    return refuse(`${actor} has ${permission} permission; write access is required to run ${names}.`);
  }

  const number = Number(issue.number);
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.state !== 'open') return refuse(`Pull request #${number} is not open.`);
  if (!allowForks && !isSameRepository(pr, owner, repo)) {
    return refuse(`Pull request #${number} comes from a fork; commands run only for branches in ${owner}/${repo}.`);
  }

  const workflows = [...new Set(requested.flatMap((entry) => entry.workflows))];
  await dispatchAll({ github, core, owner, repo, number, headSha: pr.head.sha, workflows });
  await react('eyes');
  core.setOutput('dispatched', workflows.join(','));
  return { dispatched: workflows, headSha: pr.head.sha };
}
