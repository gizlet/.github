# gizlet/.github

Organization defaults for gizlet repositories: workflow templates and the
reusable workflows they call (a Codex code reviewer, PR triage, and
slash-command gating for CI that runs pull-request code).

| Path | Role |
| --- | --- |
| `workflow-templates/` | Callers offered under **Actions → New workflow** ("By gizlet"). |
| `.github/workflows/codex-review.yml` | Reusable Codex code reviewer, requested with `/codex-review`. |
| `.github/workflows/pr-auto-trigger.yml` | Reusable PR triage: dispatches CI and review for PRs from branches in the repository. |
| `.github/workflows/pr-check-start.yml` | Reusable: authorizes `/test` or a dispatch and starts a check on the PR head. |
| `.github/workflows/pr-check-finish.yml` | Reusable: completes that check from the CI job result. |
| `.github/workflows/triage.yml`, `pr-review.yml`, `test.yml` | This repository's own callers. |
| `.github/scripts/` | Implementation and unit tests. |

Templates are copied into a repository once. The logic stays here: callers
reference the reusable workflows through the moving `latest` tag, for example
`gizlet/.github/.github/workflows/codex-review.yml@latest`, so changes reach
every repository without editing its callers.

## Adding the workflows to a repository

In the repository, open **Actions → New workflow** and add the three gizlet
templates:

| Template | File | Required check |
| --- | --- | --- |
| Gizlet PR triage | `.github/workflows/triage.yml` | — |
| Gizlet Codex review | `.github/workflows/codex-review.yml` | `Codex Code Review` |
| Gizlet gated CI | `.github/workflows/ci.yml` | `CI` |

1. In `ci.yml`, replace the placeholder `Build and test` step with the
   repository's build and test commands. It fails until replaced. Rename the
   file or its `check-name` only together with `workflows:` in `triage.yml`
   and the branch protection rule.
2. In `codex-review.yml`, describe the repository in `review-instructions`.
3. Merge to the default branch. Triggers run the default-branch copy, so the
   pull request that adds them cannot run them.
4. In branch protection, require `Codex Code Review` and `CI` (source: GitHub
   Actions).
5. Merge to the default branch; jobs run on the runners in the `RUNNERS`
   organization variable (see below).

The `OPENAI_API_KEY` organization secret is available to every repository.

## Runners

Only triage and Codex review run on GitHub-hosted runners. Every build, test,
package and release job runs on the self-hosted runner that the `RUNNERS`
organization variable names for its platform. `RUNNERS` is a JSON object whose
values are `runs-on` strings, normally ARC scale set names:

```json
{
  "default": "...",
  "linux-x64": "...",
  "linux-arm64": "...",
  "macos-x64": "...",
  "macos-arm64": "...",
  "windows-x64": "...",
  "windows-arm64": "..."
}
```

`default` runs platform-independent jobs such as check start/finish, version
checks and publishing. A job looks its runner up with
`fromJSON(vars.RUNNERS || '{}')['<key>'] || '<github-hosted label>'`, so a
missing key falls back to the matching GitHub-hosted runner until that
platform's self-hosted runner exists.

Self-hosted runners must be in a runner group that allows public
repositories. Every public repository requires approval for workflows from
outside collaborators, and gated workflows never build fork pull requests.

## Organization defaults

`scripts/apply-repo-settings.sh` applies the pull-request defaults. It is
idempotent; run it with `--dry-run` first, and again after creating a
repository or adding the Codex review caller to one.

| Setting | Where |
| --- | --- |
| Squash merging only; commit message is the PR title and description; merged branches are deleted | Repository settings, every non-archived repository |
| Workflows from outside collaborators' PRs need approval | Repository Actions settings, public repositories |
| Default branch requires `Codex Code Review`; administrators can bypass | Branch protection, public non-fork repositories that call the reviewer (private repositories need a paid plan) |
| The same, organization-wide | Organization rulesets in `rulesets/`, applied only on a paid plan |

Repository-specific checks, such as a build, stay in each repository's branch
protection; the script keeps them when it adds `Codex Code Review`.

## Commands

Post a new PR comment that starts a line with the command (not quoted and not
in a code block). Text after the command on the same line is passed along.

| Command | Effect |
| --- | --- |
| `/codex-review [focus]` | Codex reviews the diff and reports `Codex Code Review`. |
| `/test` | Runs the repository's command-gated CI on the current head. |

For pull requests from branches in the repository, `pr-auto-trigger.yml` starts
both automatically on every push; the commands rerun them or cover other
cases.

Only accounts with `write`, `maintain`, or `admin` permission on the calling
repository can run commands. Edited comments, bot comments, and other users'
commands are ignored. A refused well-formed command receives 😕. Accepted
commands receive 👀, then 👍, 👎, or 😕 when the result is reported.

Every check is attached to the head commit at the time of the request. After a
push the new head has no result until CI or a new command runs again.

## Codex code review

The reviewer only reviews code. It does not evaluate PR titles, descriptions,
or linked Issues. It starts from `/codex-review`, a writer's manual dispatch,
or `pr-auto-trigger.yml` when the caller lists its workflow (dispatches pass
`pull_request_number` and `head_sha`; a review of a superseded head is
skipped).

Each review creates a `Codex Code Review` check and posts a native PR review
with inline comments.

| Severity | Meaning | Default effect |
| --- | --- | --- |
| P0 | Must not merge: build/boot break, data loss, security hole | Fails the check |
| P1 | Real bug or regression likely to be hit | Fails the check |
| P2 | Edge-case bug or meaningful risk | Comment only |
| P3 | Minor issue with concrete benefit | Comment only |

The check also fails when the diff exceeds `max-diff-bytes`, the head moves
during the review, or Codex does not return a valid result.

- The workspace is the trusted base branch. The PR head is fetched as Git
  objects only to produce a diff and is never checked out or executed, so fork
  PRs can be reviewed.
- Codex runs through `openai/codex-action` with the `:read-only` permission
  profile and without sudo. The diff is treated as untrusted input.
- Mentions in model output are neutralized before publishing.

| Input | Default | Purpose |
| --- | --- | --- |
| `model` | `gpt-6.1-sol` | Codex model |
| `effort` | `medium` | Reasoning effort |
| `codex-version` | `0.163.0` | Exact Codex CLI version |
| `max-diff-bytes` | `2000000` | Largest reviewed diff |
| `blocking-severities` | `P0,P1` | Severities that fail the check |
| `review-instructions` | empty | Repository-specific review guidance |
| `command` | `/codex-review` | Comment command |
| `pull_request_number` | empty | PR number for `workflow_dispatch` |
| `head_sha` | empty | Expected head for `workflow_dispatch` |

Codex also follows `AGENTS.md` and `CLAUDE.md` files on the base branch.

## Command-gated CI

CI that executes pull-request code runs in a workflow with three jobs:

1. `start` calls `pr-check-start.yml`. It accepts a `/test` comment from a
   writer, or a `workflow_dispatch` with `pull_request_number` (and optionally
   `head_sha`) from a writer or from `pr-auto-trigger.yml`. It refuses fork PRs
   unless `allow-forks` is true, then creates the named check on the PR head.
2. The caller's own job checks out `needs.start.outputs.head_sha` with a
   read-only token and no secrets, and builds or tests it.
3. `finish` calls `pr-check-finish.yml` with the job result to complete the
   check.

Grant `start` and `finish` `checks: write` and `pull-requests: write` (reacting
to a PR comment needs pull-request write access), and the review caller
`checks`, `issues`, and `pull-requests` write, as in the templates.

`pr-auto-trigger.yml`, called from `pull_request_target`, dispatches the listed
workflows on the default branch whenever an open, non-draft PR from a branch in
the repository is opened, reopened, marked ready, or pushed. Only accounts and
apps with write access can push such branches. Fork PRs are never built
automatically and receive a one-time notice when opened.

Comments and dispatches always run the workflow file from the default branch,
so a PR cannot weaken its own required check by editing the workflow. Do not
add a `pull_request` trigger to a gated workflow. Push builds of the default
branch run the job directly and may save caches; PR builds should only restore
them.

## Development

```bash
node --test .github/scripts/pr-command/test.mjs .github/scripts/codex-review/test.mjs
```

After merging a change to `main`, move the tag:

```bash
git tag -f latest origin/main && git push -f origin latest
```
