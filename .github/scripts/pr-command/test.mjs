import assert from 'node:assert/strict';
import test from 'node:test';
import { autoTrigger, decide, parseWorkflows } from './auto-trigger.mjs';
import { checkResultFor, finishCheck, startCheck } from './check.mjs';
import {
  isTrustedPermission, parseCommand, resolvePullRequestCommand, validateCommand,
} from './command.mjs';

const REPO = { owner: 'gizlet', repo: 'example' };
const SHA = 'h'.repeat(40);

test('parses commands on their own line only', () => {
  const parse = (body) => parseCommand(body, '/codex-review');
  assert.deepEqual(parse('/codex-review'), { requested: true, args: '' });
  assert.deepEqual(parse('Thanks!\n  /Codex-Review  the boot scripts \n'), { requested: true, args: 'the boot scripts' });
  assert.deepEqual(parse('please /codex-review'), { requested: false, args: '' });
  assert.deepEqual(parse('/codex-reviewer'), { requested: false, args: '' });
  assert.deepEqual(parse('/codex-review-all'), { requested: false, args: '' });
  assert.deepEqual(parse('`/codex-review`'), { requested: false, args: '' });
  assert.deepEqual(parse('> /codex-review'), { requested: false, args: '' });
  assert.deepEqual(parse('    /codex-review'), { requested: false, args: '' });
  assert.deepEqual(parse('```\n/codex-review\n```'), { requested: false, args: '' });
  assert.deepEqual(parse('~~~\n```\n/codex-review\n~~~\n/codex-review'), { requested: true, args: '' });
  assert.deepEqual(parse('@codex review'), { requested: false, args: '' });
  assert.equal(parse(`/codex-review ${'x'.repeat(900)}`).args.length, 500);
  assert.deepEqual(parseCommand('/test', '/test'), { requested: true, args: '' });
  assert.deepEqual(parseCommand('/testing', '/test'), { requested: false, args: '' });
});

test('validates command names', () => {
  assert.equal(validateCommand(' /test '), '/test');
  for (const bad of ['test', '/', '/te st', '/a.*', '', undefined]) assert.throws(() => validateCommand(bad));
});

test('trusts only write-level permissions', () => {
  for (const permission of ['admin', 'maintain', 'write', 'WRITE']) assert.equal(isTrustedPermission(permission), true);
  for (const permission of ['triage', 'read', 'none', undefined]) assert.equal(isTrustedPermission(permission), false);
});

const fakeCore = () => {
  const outputs = {};
  return { outputs, setOutput: (name, value) => { outputs[name] = value; }, info() {}, notice() {}, warning() {} };
};
const pull = ({ state = 'open', head = SHA, fork = false, draft = false } = {}) => ({
  number: 7, state, draft,
  head: { sha: head, repo: { full_name: fork ? 'someone/example' : 'Gizlet/Example' } },
  base: { ref: 'main' },
});
const fakeGithub = ({ permission = 'write', missingUser = false, pr = pull() } = {}) => {
  const calls = [];
  return {
    calls,
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => {
          calls.push(['permission', username]);
          if (missingUser) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { permission } };
        },
        get: async () => ({ data: { default_branch: 'main' } }),
      },
      pulls: { get: async ({ pull_number }) => ({ data: { ...pr, number: pull_number } }) },
      reactions: { createForIssueComment: async ({ content }) => { calls.push(['reaction', content]); } },
      checks: {
        create: async (request) => { calls.push(['create', request.name, request.head_sha, request.status]); return { data: { id: 55 } }; },
        update: async (request) => { calls.push(['update', request.check_run_id, request.conclusion]); },
      },
      issues: { createComment: async ({ body }) => { calls.push(['comment', body]); } },
      actions: { createWorkflowDispatch: async (request) => { calls.push(['dispatch', request.workflow_id, request.ref, request.inputs]); } },
    },
  };
};
const commentContext = (body, type = 'User') => ({
  eventName: 'issue_comment', repo: REPO,
  payload: { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 99, body, user: { login: 'alice', type } } },
});
const dispatchContext = (actor = 'alice') => ({ eventName: 'workflow_dispatch', actor, repo: REPO, payload: { sender: { login: actor } } });

test('resolves an authorized comment command', async () => {
  const core = fakeCore();
  const result = await resolvePullRequestCommand({ github: fakeGithub(), context: commentContext('/test now'), core, command: '/test' });
  assert.equal(result.requested, true);
  assert.deepEqual(core.outputs, {
    requested: 'true', number: '7', head_sha: SHA, base_ref: 'main', comment_id: '99', args: 'now', requester: 'alice',
  });
});

test('refuses unauthorized, bot, fork, and closed requests', async () => {
  const cases = [
    [fakeGithub({ permission: 'read' }), commentContext('/test'), 'confused'],
    [fakeGithub({ missingUser: true }), commentContext('/test'), 'confused'],
    [fakeGithub({ pr: pull({ fork: true }) }), commentContext('/test'), 'confused'],
    [fakeGithub({ pr: pull({ state: 'closed' }) }), commentContext('/test'), 'confused'],
    [fakeGithub(), commentContext('/test', 'Bot'), undefined],
    [fakeGithub(), commentContext('looks good'), undefined],
    [fakeGithub(), { ...commentContext('/test'), payload: { ...commentContext('').payload, action: 'edited' } }, undefined],
    [fakeGithub(), { ...commentContext('/test'), payload: { ...commentContext('').payload, issue: { number: 7 } } }, undefined],
  ];
  for (const [github, context, reaction] of cases) {
    const core = fakeCore();
    const result = await resolvePullRequestCommand({ github, context, core, command: '/test' });
    assert.equal(result.requested, false, result.reason);
    assert.equal(core.outputs.requested, 'false');
    assert.equal(github.calls.find((call) => call[0] === 'reaction')?.[1], reaction, result.reason);
  }
});

test('accepts forks only when allowed', async () => {
  const github = fakeGithub({ pr: pull({ fork: true }) });
  const result = await resolvePullRequestCommand({ github, context: commentContext('/codex-review'), core: fakeCore(), command: '/codex-review', allowForks: true });
  assert.equal(result.requested, true);
});

test('resolves dispatches from writers and automation', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  const result = await resolvePullRequestCommand({ github, context: dispatchContext(), core, command: '/test', requestedNumber: ' 12 ' });
  assert.equal(result.number, '12');
  assert.equal(core.outputs.comment_id, '');
  assert.deepEqual(github.calls, [['permission', 'alice']]);

  const automation = fakeGithub({ permission: 'none' });
  const automated = await resolvePullRequestCommand({
    github: automation, context: dispatchContext('github-actions[bot]'), core: fakeCore(), command: '/test', requestedNumber: '12', expectedHeadSha: SHA,
  });
  assert.equal(automated.requested, true);
  assert.deepEqual(automation.calls, []);

  const reader = await resolvePullRequestCommand({ github: fakeGithub({ permission: 'read' }), context: dispatchContext('bob'), core: fakeCore(), command: '/test', requestedNumber: '12' });
  assert.equal(reader.requested, false);
  const moved = await resolvePullRequestCommand({ github: fakeGithub(), context: dispatchContext(), core: fakeCore(), command: '/test', requestedNumber: '12', expectedHeadSha: 'a'.repeat(40) });
  assert.equal(moved.requested, false);
  assert.match(moved.reason, /moved/);
  await assert.rejects(resolvePullRequestCommand({ github: fakeGithub(), context: dispatchContext(), core: fakeCore(), command: '/test', requestedNumber: 'x' }));
});

test('starts and finishes checks', async () => {
  const github = fakeGithub();
  const core = fakeCore();
  await startCheck({ github, context: { repo: REPO, runId: 1 }, core, env: { CHECK_NAME: 'Build', PR_HEAD_SHA: SHA, PULL_REQUEST_NUMBER: '7', REQUEST_COMMENT_ID: '99', DETAILS_URL: 'u' } });
  assert.equal(core.outputs.check_run_id, '55');
  await finishCheck({ github, context: { repo: REPO }, core, env: { CHECK_RUN_ID: '55', JOB_RESULT: 'failure', REQUEST_COMMENT_ID: '99', DETAILS_URL: 'u' } });
  await finishCheck({ github, context: { repo: REPO }, core, env: { CHECK_RUN_ID: '55', JOB_RESULT: 'success', DETAILS_URL: 'u' } });
  assert.deepEqual(github.calls, [
    ['create', 'Build', SHA, 'in_progress'], ['reaction', 'eyes'],
    ['update', 55, 'failure'], ['reaction', '-1'],
    ['update', 55, 'success'],
  ]);
  assert.equal(checkResultFor('cancelled').conclusion, 'cancelled');
  assert.equal(checkResultFor('skipped').conclusion, 'failure');
  assert.equal(checkResultFor('').title, 'Did not run');
});

test('validates workflow lists', () => {
  assert.deepEqual(parseWorkflows(' build.yml, test.yaml,build.yml '), ['build.yml', 'test.yaml']);
  for (const bad of ['', 'build', '../x.yml', 'a/b.yml']) assert.throws(() => parseWorkflows(bad));
});

test('decides automatic triggers', () => {
  const at = (pr) => decide({ pr, ...REPO, eventHeadSha: SHA });
  assert.equal(at(pull()).dispatch, true);
  assert.equal(at(pull({ draft: true })).dispatch, false);
  assert.equal(at(pull({ state: 'closed' })).dispatch, false);
  assert.equal(at(pull({ head: 'b'.repeat(40) })).dispatch, false);
  assert.deepEqual(at(pull({ fork: true })).fork, true);
  assert.equal(at({ ...pull(), head: { sha: SHA, repo: null } }).fork, true);
});

const targetContext = (action) => ({
  eventName: 'pull_request_target', repo: REPO,
  payload: { action, pull_request: { number: 7, head: { sha: SHA } } },
});
const env = { WORKFLOWS: 'build.yml,lint.yml', COMMAND: '/test' };

test('dispatches workflows for same-repository pull requests', async () => {
  const github = fakeGithub();
  const result = await autoTrigger({ github, context: targetContext('synchronize'), core: fakeCore(), env });
  assert.equal(result.dispatch, true);
  assert.deepEqual(github.calls, [
    ['dispatch', 'build.yml', 'main', { pull_request_number: '7', head_sha: SHA }],
    ['dispatch', 'lint.yml', 'main', { pull_request_number: '7', head_sha: SHA }],
  ]);
});

test('posts a single notice for fork pull requests', async () => {
  const opened = fakeGithub({ pr: pull({ fork: true }) });
  await autoTrigger({ github: opened, context: targetContext('opened'), core: fakeCore(), env });
  assert.deepEqual(opened.calls.map((call) => call[0]), ['comment']);
  assert.match(opened.calls[0][1], /forks/);
  const pushed = fakeGithub({ pr: pull({ fork: true }) });
  await autoTrigger({ github: pushed, context: targetContext('synchronize'), core: fakeCore(), env });
  assert.deepEqual(pushed.calls, []);
  await assert.rejects(autoTrigger({ github: fakeGithub(), context: { ...targetContext('opened'), eventName: 'pull_request' }, core: fakeCore(), env }));
});
