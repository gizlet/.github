// Decides whether a pull request may start its CI automatically and, if so,
// dispatches the caller's workflows on the trusted default branch.

import { isSameRepository, validateCommand } from './command.mjs';

const HINT_MARKER = '<!-- gizlet-pr-auto-trigger -->';

export function parseWorkflows(value) {
  const workflows = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!workflows.length) throw new Error('At least one workflow file is required.');
  for (const workflow of workflows) {
    if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(workflow)) throw new Error(`Invalid workflow file name: ${workflow}`);
  }
  return [...new Set(workflows)];
}

/** Pure decision for a live pull request. */
export function decide({ pr, owner, repo, eventHeadSha }) {
  if (pr.state !== 'open') return { dispatch: false, reason: 'The pull request is not open.' };
  if (pr.head.sha !== eventHeadSha) return { dispatch: false, reason: `The head moved to ${pr.head.sha}; its own event triggers CI.` };
  if (pr.draft) return { dispatch: false, reason: 'Draft pull requests do not start CI automatically.' };
  // Only users and apps with write access can push branches to this repository.
  if (!isSameRepository(pr, owner, repo)) return { dispatch: false, fork: true, reason: 'Fork pull requests never start CI automatically.' };
  return { dispatch: true, reason: 'The head branch is in this repository.' };
}

export async function autoTrigger({ github, context, core, env = process.env }) {
  if (context.eventName !== 'pull_request_target') {
    throw new Error(`pr-auto-trigger must be called from pull_request_target, not ${context.eventName}.`);
  }
  const workflows = parseWorkflows(env.WORKFLOWS);
  const command = validateCommand(env.COMMAND);
  const { owner, repo } = context.repo;
  const number = Number(context.payload.pull_request.number);
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const decision = decide({ pr, owner, repo, eventHeadSha: context.payload.pull_request.head.sha });
  core.info(decision.reason);
  core.setOutput('dispatched', String(decision.dispatch));

  if (!decision.dispatch) {
    if (decision.fork && context.payload.action === 'opened') {
      await github.rest.issues.createComment({
        owner, repo, issue_number: number,
        body: [
          HINT_MARKER,
          `CI does not run for pull requests from forks, and \`${command}\` is refused for them, so required checks will not report here.`,
          `Push the branch to ${owner}/${repo} to build it.`,
        ].join('\n'),
      }).catch((error) => core.warning(`Could not post the fork notice: ${error.message}`));
    }
    return decision;
  }

  const { data: repository } = await github.rest.repos.get({ owner, repo });
  for (const workflow of workflows) {
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: workflow, ref: repository.default_branch,
      inputs: { pull_request_number: String(number), head_sha: pr.head.sha },
    });
    core.info(`Dispatched ${workflow} on ${repository.default_branch} for #${number} at ${pr.head.sha}.`);
  }
  return { ...decision, workflows };
}
