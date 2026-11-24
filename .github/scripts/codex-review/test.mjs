import assert from 'node:assert/strict';
import test from 'node:test';
import { commentableLines } from './diff.mjs';
import { buildPrompt } from './prompt.mjs';
import { evaluateOutcome, publishReview } from './publish.mjs';
import {
  buildReview,
  conclusionFor,
  neutralizeMentions,
  parseBlockingSeverities,
  parseReviewResult,
} from './result.mjs';

const fakeCore = () => {
  const outputs = {};
  return { outputs, setOutput: (name, value) => { outputs[name] = value; }, info() {}, notice() {}, warning() {} };
};
const DIFF = [
  'diff --git a/src/a.c b/src/a.c',
  'index 1111111..2222222 100644',
  '--- a/src/a.c',
  '+++ b/src/a.c',
  '@@ -10,4 +10,5 @@ int main(void)',
  ' keep();',
  '-old();',
  '+new();',
  '+++counter;',
  ' tail();',
  '\\ No newline at end of file',
  '@@ -40 +41 @@',
  '-x',
  '+y',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');

test('maps commentable new-side diff lines', () => {
  const lines = commentableLines(DIFF);
  assert.deepEqual([...lines.keys()], ['src/a.c', 'new.txt']);
  assert.deepEqual([...lines.get('src/a.c')], [10, 11, 12, 13, 41]);
  assert.deepEqual([...lines.get('new.txt')], [1]);
});

const finding = (severity, path = 'src/a.c', line = 11) => ({ severity, title: `${severity} issue`, body: 'Breaks @team things.', path, line });

test('validates review results', () => {
  const parsed = parseReviewResult(`\`\`\`json\n${JSON.stringify({ summary: ' ok ', findings: [finding('P3'), finding('P1', './src/a.c')] })}\n\`\`\``);
  assert.equal(parsed.summary, 'ok');
  assert.deepEqual(parsed.findings.map((item) => [item.severity, item.path]), [['P1', 'src/a.c'], ['P3', 'src/a.c']]);
  assert.throws(() => parseReviewResult('not json'));
  assert.throws(() => parseReviewResult(JSON.stringify({ summary: '', findings: [{ ...finding('P1'), severity: 'high' }] })));
  assert.throws(() => parseReviewResult(JSON.stringify({ summary: '', findings: [{ ...finding('P1'), line: -1 }] })));
  assert.throws(() => parseReviewResult(JSON.stringify({ findings: [] })));
});

test('blocks only configured severities', () => {
  const blocking = parseBlockingSeverities('p0, P1');
  assert.equal(conclusionFor([finding('P2'), finding('P3')], blocking), 'success');
  assert.equal(conclusionFor([finding('P2'), finding('P1')], blocking), 'failure');
  assert.equal(conclusionFor([], blocking), 'success');
  assert.throws(() => parseBlockingSeverities('P1,P9'));
});

test('builds inline comments and lists unanchored findings', () => {
  const blocking = parseBlockingSeverities('P0,P1');
  const findings = [finding('P1'), finding('P2', 'src/a.c', 99), finding('P3', '', 0)];
  const review = buildReview({ summary: 'ping @alice', findings, lines: commentableLines(DIFF), conclusion: 'failure', blocking, headSha: 'abc' });
  assert.deepEqual(review.comments.map(({ path, line, side }) => [path, line, side]), [['src/a.c', 11, 'RIGHT']]);
  assert.match(review.body, /❌ 1 blocking finding \(P0, P1\)/);
  assert.match(review.body, /`src\/a\.c:99`: \*\*\[P2\]/);
  assert.match(review.body, /General: \*\*\[P3\]/);
  assert.doesNotMatch(review.body, /@alice|@team/);
  assert.equal(neutralizeMentions('@a @ b'), '@\u200ba @ b');
});

const baseEnv = {
  BLOCKING_SEVERITIES: 'P0,P1', JOB_STATUS: 'success', PREPARE_OUTCOME: 'success', TOO_LARGE: 'false',
  DIFF_BYTES: '120', MAX_DIFF_BYTES: '100', CODEX_OUTCOME: 'success', RESULT_FILE: 'result.json',
};

test('evaluates step outcomes', () => {
  const read = (result) => () => JSON.stringify(result);
  assert.equal(evaluateOutcome({ ...baseEnv, JOB_STATUS: 'cancelled' }).conclusion, 'cancelled');
  assert.match(evaluateOutcome({ ...baseEnv, PREPARE_OUTCOME: 'failure', PREPARE_FAILURE: 'no fetch' }).summary, /no fetch/);
  assert.equal(evaluateOutcome({ ...baseEnv, TOO_LARGE: 'true' }).title, 'Diff too large');
  assert.equal(evaluateOutcome({ ...baseEnv, DIFF_BYTES: '0' }).conclusion, 'success');
  assert.equal(evaluateOutcome({ ...baseEnv, CODEX_OUTCOME: 'failure' }).kind, 'error');
  assert.equal(evaluateOutcome({ ...baseEnv, CODEX_OUTCOME: '' }).kind, 'error');
  assert.equal(evaluateOutcome(baseEnv, () => '{').title, 'Invalid review output');
  assert.equal(evaluateOutcome(baseEnv, read({ summary: 'fine', findings: [finding('P2')] })).conclusion, 'success');
  assert.equal(evaluateOutcome(baseEnv, read({ summary: 'bad', findings: [finding('P0')] })).conclusion, 'failure');
});

test('publishes a review, retries without inline comments, and completes the check', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'pr.diff'), DIFF);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ summary: 'bad', findings: [finding('P1')] }));
  const calls = [];
  let rejectInline = true;
  const github = {
    rest: {
      pulls: {
        createReview: async (request) => {
          calls.push(['review', request.comments.length]);
          if (rejectInline && request.comments.length) throw Object.assign(new Error('Unprocessable'), { status: 422 });
          return {};
        },
      },
      checks: { update: async (request) => { calls.push(['check', request.conclusion, request.output.title]); } },
      reactions: { createForIssueComment: async ({ content }) => { calls.push(['reaction', content]); } },
      issues: { createComment: async () => { calls.push(['comment']); } },
    },
  };
  const env = {
    ...baseEnv, DIFF_BYTES: '50', MAX_DIFF_BYTES: '100', DIFF_FILE: path.join(dir, 'pr.diff'),
    RESULT_FILE: path.join(dir, 'result.json'), PULL_REQUEST_NUMBER: '7', PR_HEAD_SHA: 'h', CHECK_RUN_ID: '5',
    REQUEST_COMMENT_ID: '9', DETAILS_URL: 'https://example.invalid/run',
  };
  const core = fakeCore();
  await publishReview({ github, context: { repo: { owner: 'gizlet', repo: 'example' } }, core, env });
  assert.deepEqual(calls, [['review', 1], ['review', 0], ['check', 'failure', '❌ 1 blocking finding (P0, P1).'], ['reaction', '-1']]);
  assert.equal(core.outputs.conclusion, 'failure');

  calls.length = 0;
  rejectInline = false;
  await publishReview({ github, context: { repo: { owner: 'gizlet', repo: 'example' } }, core: fakeCore(), env: { ...env, CODEX_OUTCOME: 'failure' } });
  assert.deepEqual(calls.map((call) => call[0]), ['comment', 'check', 'reaction']);
  assert.equal(calls[2][1], 'confused');
});

test('builds a prompt with optional instructions and focus', () => {
  const env = {
    PULL_REQUEST_NUMBER: '7', GITHUB_REPOSITORY: 'gizlet/example', PR_BASE_REF: 'main', PR_BASE_TIP_SHA: 'b',
    PR_MERGE_BASE_SHA: 'm', PR_HEAD_SHA: 'h', DIFF_FILE: '.codex-review/pr.diff', FILES_FILE: '.codex-review/files.txt',
    DIFF_BYTES: '50', BLOCKING_SEVERITIES: 'P0,P1',
  };
  const plain = buildPrompt(env);
  assert.match(plain, /pull request #7 in gizlet\/example/);
  assert.match(plain, /severity P0 or P1 block the merge/);
  assert.doesNotMatch(plain, /## Repository instructions|## Focus/);
  const full = buildPrompt({ ...env, REVIEW_INSTRUCTIONS: 'Check Bazel.', REVIEW_FOCUS: 'boot' });
  assert.match(full, /## Repository instructions\n\nCheck Bazel\./);
  assert.match(full, /## Focus requested by the reviewer\n\nboot/);
});
