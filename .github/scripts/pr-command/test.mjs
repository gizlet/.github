import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAuto, parseCommandList, triage, triageComment } from './triage.mjs';
import { checkResultFor, finishCheck, startCheck } from './check.mjs';
import {
  headMarker, isTrustedPermission, markedHead, parseCommand, resolvePullRequestCommand, validateCommand,
} from './command.mjs';

const REPO = { owner: 'gizlet', repo: 'example' };
const SHA = 'c'.repeat(40);

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
  assert.deepEqual(parseCommand('/ci', '/ci'), { requested: true, args: '' });
  assert.deepEqual(parseCommand('/cip', '/ci'), { requested: false, args: '' });
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
      issues: { createComment: async ({ issue_number, body }) => { calls.push(['comment', issue_number, body]); return { data: { id: 123 } }; } },
      actions: { createWorkflowDispatch: async (request) => { calls.push(['dispatch', request.workflow_id, request.ref, request.inputs]); } },
    },
  };
};
const commentContext = (body, type = 'User', login = 'alice') => ({
  eventName: 'issue_comment', repo: REPO,
  payload: { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 99, body, user: { login, type } } },
});
const botContext = (body) => commentContext(body, 'Bot', 'gizlet-bot[bot]');
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

test('resolves dispatches from writers only', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  const result = await resolvePullRequestCommand({ github, context: dispatchContext(), core, command: '/ci', requestedNumber: ' 12 ' });
  assert.equal(result.number, '12');
  assert.equal(core.outputs.comment_id, '');
  assert.deepEqual(github.calls, [['permission', 'alice']]);

  // Nothing dispatches on a writer's behalf any more, workflows included.
  const automated = await resolvePullRequestCommand({
    github: fakeGithub({ missingUser: true }), context: dispatchContext('github-actions[bot]'), core: fakeCore(), command: '/ci', requestedNumber: '12',
  });
  assert.equal(automated.requested, false);

  const reader = await resolvePullRequestCommand({ github: fakeGithub({ permission: 'read' }), context: dispatchContext('bob'), core: fakeCore(), command: '/ci', requestedNumber: '12' });
  assert.equal(reader.requested, false);
  const moved = await resolvePullRequestCommand({ github: fakeGithub(), context: dispatchContext(), core: fakeCore(), command: '/ci', requestedNumber: '12', expectedHeadSha: 'a'.repeat(40) });
  assert.equal(moved.requested, false);
  assert.match(moved.reason, /moved/);
  await assert.rejects(resolvePullRequestCommand({ github: fakeGithub(), context: dispatchContext(), core: fakeCore(), command: '/ci', requestedNumber: 'x' }));
});

test('trusts gizlet-bot comments for the head they name', async () => {
  const body = triageComment(['/ci', '/codex-review'], SHA);
  assert.equal(markedHead(body), SHA);
  assert.equal(markedHead('/ci'), '');
  assert.equal(headMarker(SHA), `<!-- gizlet-triage head_sha=${SHA} -->`);

  const github = fakeGithub({ missingUser: true });
  const core = fakeCore();
  const result = await resolvePullRequestCommand({ github, context: botContext(body), core, command: '/ci' });
  assert.equal(result.requested, true, result.reason);
  assert.equal(core.outputs.requester, 'gizlet-bot[bot]');
  assert.equal(core.outputs.args, '');
  assert.deepEqual(github.calls, [], 'no permission lookup for the bot');
  assert.equal((await resolvePullRequestCommand({ github: fakeGithub(), context: botContext(body), core: fakeCore(), command: '/codex-review' })).requested, true);

  // A newer push has its own comment: an older one does nothing, quietly.
  const old = await resolvePullRequestCommand({ github: fakeGithub(), context: botContext(triageComment(['/ci'], 'a'.repeat(40))), core: fakeCore(), command: '/ci' });
  assert.equal(old.requested, false);
  assert.match(old.reason, /moved/);
  // Without a marker, or from any other bot, a comment runs nothing.
  for (const context of [botContext('/ci'), commentContext(body, 'Bot', 'other-bot[bot]'), commentContext(body, 'Bot', 'github-actions[bot]')]) {
    const github = fakeGithub();
    const refused = await resolvePullRequestCommand({ github, context, core: fakeCore(), command: '/ci' });
    assert.equal(refused.requested, false, refused.reason);
    assert.deepEqual(github.calls, [], refused.reason);
  }
  // A user cannot borrow the bot's marker to pin another head: users need write access as always.
  const reader = await resolvePullRequestCommand({ github: fakeGithub({ permission: 'read' }), context: commentContext(body), core: fakeCore(), command: '/ci' });
  assert.equal(reader.requested, false);
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

test('parses the commands to comment', () => {
  assert.deepEqual(parseCommandList('/ci\n /codex-review \n'), ['/ci', '/codex-review']);
  assert.deepEqual(parseCommandList('/ci, /codex-review'), ['/ci', '/codex-review']);
  // The older mapping form still parses; its workflows are ignored.
  assert.deepEqual(parseCommandList('/test=build.yml\n/codex-review=codex-review.yml'), ['/test', '/codex-review']);
  for (const bad of ['', 'ci', '/', '/ci\n/CI', '/c i']) assert.throws(() => parseCommandList(bad), bad);
});

test('the triage comment holds each command on its own line and the head', () => {
  const body = triageComment(['/ci', '/codex-review'], SHA);
  assert.equal(parseCommand(body, '/ci').requested, true);
  assert.equal(parseCommand(body, '/codex-review').requested, true);
  assert.equal(parseCommand(body, '/release').requested, false);
  assert.equal(markedHead(body), SHA);
});

const COMMANDS = '/ci\n/codex-review';
const prEvent = (github, action, { head = SHA } = {}) => triage({
  github, core: fakeCore(), env: { COMMANDS },
  context: { eventName: 'pull_request_target', repo: REPO, payload: { action, pull_request: { number: 7, head: { sha: head } } } },
});

test('a pull request update gets one triage comment and no dispatch', async () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
    const github = fakeGithub();
    const result = await prEvent(github, action);
    assert.equal(result.commented, true, action);
    assert.deepEqual(github.calls, [['comment', 7, triageComment(['/ci', '/codex-review'], SHA)]], action);
  }
});

test('drafts, forks, closed pull requests, stale heads and other actions get no comment', async () => {
  for (const [github, action, options] of [
    [fakeGithub({ pr: pull({ draft: true }) }), 'synchronize', {}],
    [fakeGithub({ pr: pull({ fork: true }) }), 'opened', {}],
    [fakeGithub({ pr: pull({ state: 'closed' }) }), 'synchronize', {}],
    [fakeGithub(), 'synchronize', { head: 'f'.repeat(40) }],
    [fakeGithub(), 'edited', {}],
  ]) {
    const result = await prEvent(github, action, options);
    assert.equal(result.commented, false, result.reason);
    assert.equal(github.calls.length, 0, result.reason);
  }
  assert.equal(decideAuto({ action: 'labeled', pr: pull(), owner: 'gizlet', repo: 'example', eventHeadSha: SHA }).comment, false);
});

test('comments reaching triage from older callers do nothing; other events are errors', async () => {
  const github = fakeGithub();
  const result = await triage({ github, core: fakeCore(), env: { COMMANDS }, context: commentContext('/ci') });
  assert.equal(result.commented, false);
  assert.deepEqual(github.calls, []);
  await assert.rejects(triage({ github: fakeGithub(), core: fakeCore(), env: { COMMANDS }, context: { eventName: 'push', repo: REPO, payload: {} } }));
});
