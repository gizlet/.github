// Check runs that report a command-triggered job on the pull-request head.

const RESULTS = {
  success: { conclusion: 'success', title: 'Passed', reaction: '+1' },
  failure: { conclusion: 'failure', title: 'Failed', reaction: '-1' },
  cancelled: { conclusion: 'cancelled', title: 'Cancelled', reaction: 'confused' },
};

/** Maps a `needs.<job>.result` value to a check conclusion. */
export function checkResultFor(result) {
  return RESULTS[result] ?? { conclusion: 'failure', title: 'Did not run', reaction: 'confused' };
}

export async function startCheck({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const { data: check } = await github.rest.checks.create({
    owner, repo, name: env.CHECK_NAME, head_sha: env.PR_HEAD_SHA,
    status: 'in_progress', started_at: new Date().toISOString(),
    details_url: env.DETAILS_URL,
    external_id: `${context.runId}:${env.PULL_REQUEST_NUMBER}`,
    output: {
      title: 'In progress',
      summary: `Running for \`${env.PR_HEAD_SHA}\`. [Open the Actions run](${env.DETAILS_URL}).`,
    },
  });
  core.setOutput('check_run_id', String(check.id));
  const commentId = Number(env.REQUEST_COMMENT_ID);
  if (Number.isSafeInteger(commentId) && commentId > 0) {
    await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: 'eyes' })
      .catch((error) => core.warning(`Could not react to the comment: ${error.message}`));
  }
  return check.id;
}

export async function finishCheck({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const result = checkResultFor(env.JOB_RESULT);
  await github.rest.checks.update({
    owner, repo, check_run_id: Number(env.CHECK_RUN_ID),
    status: 'completed', conclusion: result.conclusion, completed_at: new Date().toISOString(),
    output: {
      title: result.title,
      summary: `The job finished with result \`${env.JOB_RESULT || 'unknown'}\`. [Open the Actions run](${env.DETAILS_URL}).`,
    },
  });
  const commentId = Number(env.REQUEST_COMMENT_ID);
  if (Number.isSafeInteger(commentId) && commentId > 0) {
    await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: result.reaction })
      .catch((error) => core.warning(`Could not react to the comment: ${error.message}`));
  }
  core.info(`${result.title} (${result.conclusion}).`);
  return result;
}
