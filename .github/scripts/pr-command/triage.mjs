// Routes pull-request slash commands to the caller's workflows. The only
// trigger for pull-request CI and review: a writer's comment such as `/test`
// dispatches the mapped workflows on the default branch for the current head.

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

export async function triage({ github, context, core, env = process.env }) {
  if (context.eventName !== 'issue_comment') {
    throw new Error(`pr-triage must be called from issue_comment, not ${context.eventName}.`);
  }
  const commands = parseCommandMap(env.COMMANDS);
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

  const { data: repository } = await github.rest.repos.get({ owner, repo });
  const workflows = [...new Set(requested.flatMap((entry) => entry.workflows))];
  for (const workflow of workflows) {
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: workflow, ref: repository.default_branch,
      inputs: { pull_request_number: String(number), head_sha: pr.head.sha },
    });
    core.info(`Dispatched ${workflow} on ${repository.default_branch} for #${number} at ${pr.head.sha}.`);
  }
  await react('eyes');
  core.setOutput('dispatched', workflows.join(','));
  return { dispatched: workflows, headSha: pr.head.sha };
}
