// Starts pull-request CI and review with a comment. When a pull request is
// opened, updated, reopened or marked ready, the triage bot comments every
// command on its own line, such as `/ci` and `/codex-review`, with a hidden
// marker naming the head. Each gated workflow listens to new comments and runs
// when one holds its command, from a writer or from the triage bot; the bot's
// comments apply only to the head they name.
//
// Triage only comments: it never dispatches a workflow. It must comment with
// a GitHub App token, since comments made with a workflow's GITHUB_TOKEN start
// no other workflow.

import { headMarker, isSameRepository, validateCommand } from './command.mjs';

/**
 * Parses the commands to comment, one per line or comma: `/ci`. The older
 * `/command=workflow.yml` form is accepted and its workflows are ignored.
 */
export function parseCommandList(value) {
  const commands = [];
  for (const raw of String(value ?? '').split(/[\n,]/)) {
    const line = raw.trim();
    if (!line) continue;
    const command = validateCommand(line.split('=')[0]);
    if (commands.some((known) => known.toLowerCase() === command.toLowerCase())) {
      throw new Error(`Duplicate command: ${command}`);
    }
    commands.push(command);
  }
  if (!commands.length) throw new Error('At least one command is required.');
  return commands;
}

const AUTO_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** Whether a pull-request event gets a triage comment; pure. */
export function decideAuto({ action, pr, owner, repo, eventHeadSha }) {
  if (!AUTO_ACTIONS.has(action)) return { comment: false, reason: `The ${action} event does not start CI.` };
  if (pr.state !== 'open') return { comment: false, reason: 'The pull request is not open.' };
  if (pr.head.sha !== eventHeadSha) return { comment: false, reason: `The head moved to ${pr.head.sha}; its own event starts CI.` };
  if (pr.draft) return { comment: false, reason: 'Draft pull requests start CI when marked ready, or with a command comment.' };
  if (!isSameRepository(pr, owner, repo)) return { comment: false, reason: 'Fork pull requests never start CI on their own.' };
  return { comment: true, reason: 'The head branch is in this repository.' };
}

/** The triage comment for a head. */
export function triageComment(commands, headSha) {
  return [
    ...commands,
    '',
    `<sub>Triage for \`${headSha.slice(0, 7)}\`. Comment a command on its own line to run it again.</sub>`,
    headMarker(headSha),
  ].join('\n');
}

export async function triage({ github, context, core, env = process.env }) {
  const commands = parseCommandList(env.COMMANDS);
  const done = (reason) => {
    core.info(reason);
    core.setOutput('comment_id', '');
    return { commented: false, reason };
  };
  // Callers from before comment triggers also call triage for comments; the
  // gated workflows now handle those themselves.
  if (context.eventName === 'issue_comment') return done('Comments are handled by the gated workflows.');
  if (context.eventName !== 'pull_request_target') {
    throw new Error(`pr-triage must be called from pull_request_target, not ${context.eventName}.`);
  }
  const { owner, repo } = context.repo;
  const number = Number(context.payload.pull_request.number);
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const decision = decideAuto({
    action: context.payload.action, pr, owner, repo, eventHeadSha: context.payload.pull_request.head.sha,
  });
  if (!decision.comment) return done(decision.reason);
  const { data: comment } = await github.rest.issues.createComment({
    owner, repo, issue_number: number, body: triageComment(commands, pr.head.sha),
  });
  core.info(`Commented ${commands.join(', ')} on #${number} for ${pr.head.sha}.`);
  core.setOutput('comment_id', String(comment.id));
  return { commented: true, commentId: comment.id, commands, headSha: pr.head.sha };
}
