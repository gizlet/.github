// Publishes the review result as a PR review and completes the check run.

import fs from 'node:fs';
import { commentableLines } from './diff.mjs';
import {
  buildCheckOutput,
  buildReview,
  conclusionFor,
  parseBlockingSeverities,
  parseReviewResult,
} from './result.mjs';

const REACTIONS = { success: '+1', failure: '-1' };

/** Decides the outcome from earlier step results without network access. */
export function evaluateOutcome(env, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  const blocking = parseBlockingSeverities(env.BLOCKING_SEVERITIES);
  if (env.JOB_STATUS === 'cancelled') {
    return { kind: 'error', conclusion: 'cancelled', title: 'Review cancelled', summary: 'The review run was cancelled before it completed.' };
  }
  if (env.PREPARE_OUTCOME !== 'success') {
    return { kind: 'error', conclusion: 'failure', title: 'Review could not start', summary: env.PREPARE_FAILURE || 'Preparing the pull-request diff failed.' };
  }
  if (env.TOO_LARGE === 'true') {
    return {
      kind: 'error', conclusion: 'failure', title: 'Diff too large',
      summary: `The diff is ${env.DIFF_BYTES} bytes, above the ${env.MAX_DIFF_BYTES}-byte review limit. Split the pull request.`,
    };
  }
  if (env.DIFF_BYTES === '0') {
    return { kind: 'review', blocking, conclusion: 'success', summary: 'The pull request has no changes relative to its merge base.', findings: [] };
  }
  if (env.CODEX_OUTCOME !== 'success') {
    return { kind: 'error', conclusion: 'failure', title: 'Codex did not finish', summary: `The Codex review step ended with outcome \`${env.CODEX_OUTCOME || 'skipped'}\`. See the Actions run for details.` };
  }
  try {
    const result = parseReviewResult(readFile(env.RESULT_FILE));
    return { kind: 'review', blocking, conclusion: conclusionFor(result.findings, blocking), ...result };
  } catch (error) {
    return { kind: 'error', conclusion: 'failure', title: 'Invalid review output', summary: `Codex returned an unusable result: ${String(error.message).slice(0, 500)}` };
  }
}

export async function publishReview({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const number = Number(env.PULL_REQUEST_NUMBER);
  const headSha = env.PR_HEAD_SHA;
  const outcome = evaluateOutcome(env);
  let output;

  if (outcome.kind === 'review') {
    const diff = env.DIFF_BYTES === '0' ? '' : fs.readFileSync(env.DIFF_FILE, 'utf8');
    const review = buildReview({ ...outcome, lines: commentableLines(diff), headSha });
    const request = { owner, repo, pull_number: number, commit_id: headSha, event: 'COMMENT', body: review.body, comments: review.comments };
    try {
      await github.rest.pulls.createReview(request);
    } catch (error) {
      if (error.status !== 422 || review.comments.length === 0) throw error;
      // GitHub rejected an inline anchor; publish every finding in the body instead.
      core.warning(`Inline review comments were rejected (${error.message}); retrying without them.`);
      const fallback = buildReview({ ...outcome, lines: new Map(), headSha });
      await github.rest.pulls.createReview({ ...request, body: fallback.body, comments: [] });
    }
    output = buildCheckOutput(outcome);
  } else {
    output = { title: outcome.title, summary: outcome.summary };
    if (outcome.conclusion !== 'cancelled') {
      await github.rest.issues.createComment({
        owner, repo, issue_number: number,
        body: `### Codex Code Review\n\n❌ ${outcome.title}: ${outcome.summary}\n\n<sub>Head \`${headSha}\`. [Actions run](${env.DETAILS_URL}).</sub>`,
      }).catch((error) => core.warning(`Could not post the failure comment: ${error.message}`));
    }
  }

  await github.rest.checks.update({
    owner, repo, check_run_id: Number(env.CHECK_RUN_ID),
    status: 'completed', conclusion: outcome.conclusion, completed_at: new Date().toISOString(),
    output: { ...output, summary: `${output.summary}\n\n[Open the Actions run](${env.DETAILS_URL}).` },
  });

  const commentId = Number(env.REQUEST_COMMENT_ID);
  if (Number.isSafeInteger(commentId) && commentId > 0) {
    await github.rest.reactions.createForIssueComment({
      owner, repo, comment_id: commentId,
      content: outcome.kind === 'review' ? REACTIONS[outcome.conclusion] : 'confused',
    }).catch((error) => core.warning(`Could not react to the request comment: ${error.message}`));
  }

  core.setOutput('conclusion', outcome.conclusion);
  core.info(`${output.title}`);
  return outcome;
}
