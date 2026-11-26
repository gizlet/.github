# gizlet/.github

Organization defaults for gizlet repositories: workflow templates and the
reusable workflows they call (a Codex code reviewer, PR triage, and
slash-command gating for CI that runs pull-request code).

| Path | Role |
| --- | --- |
| `workflow-templates/` | Callers offered under **Actions → New workflow** ("By gizlet"), with the Gizlet icon (`gizlet.svg`, a copy of `design/icon/mark.svg` in gizlet/gizlet). |
| `.github/workflows/codex-review.yml` | Reusable Codex code reviewer, requested with `/codex-review`. |
| `.github/workflows/pr-triage.yml` | Reusable PR triage: when a PR is opened or updated, gizlet-bot comments `/ci` and `/codex-review`, which starts CI and review. |
| `.github/workflows/pr-check-start.yml` | Reusable: authorizes a command comment (or a writer's dispatch) and starts a check on the PR head. |
| `.github/workflows/pr-check-finish.yml` | Reusable: completes that check from the CI job result. |
| `.github/workflows/triage.yml`, `pr-review.yml`, `test.yml` | This repository's own callers. |
| `.github/scripts/` | Implementation and unit tests. |
| `assets/gizlet-bot.png` | gizlet-bot's avatar. |

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
   file freely; rename its `command` only together with `commands:` in
   `triage.yml`, and its `check-name` only together with the branch protection
   rule.
2. In `codex-review.yml`, describe the repository in `review-instructions`.
3. Merge to the default branch. Triggers run the default-branch copy, so the
   pull request that adds them cannot run them.
4. In branch protection, require `Codex Code Review` and `CI` (source: GitHub
   Actions).
5. Merge to the default branch; jobs run on the runners in the `RUNNERS`
   organization variable (see below).

The `OPENAI_API_KEY` organization secret, and gizlet-bot's
`GIZLET_BOT_CLIENT_ID` organization variable and `GIZLET_BOT_PRIVATE_KEY`
organization secret, are available to every repository. gizlet-bot is a GitHub
App owned by the organization and installed on all its repositories, with
issues and pull requests write access and no webhook; triage comments as it
because comments made with a workflow's `GITHUB_TOKEN` start no other
workflow.

## Runners

Triage, Codex review and the check start/finish jobs (GitHub API calls only)
run on GitHub-hosted runners. Every build, test,
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

`default` runs platform-independent build jobs such as version checks and
publishing. A job looks its runner up with
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
| Squash merging only; commit message is the PR title and description; auto-merge allowed; merged branches are deleted | Repository settings, every non-archived repository |
| Workflows from outside collaborators' PRs need approval | Repository Actions settings, public repositories |
| Default branch requires `Codex Code Review`; administrators can bypass | Branch protection, public non-fork repositories that call the reviewer (private repositories need a paid plan) |
| The same, organization-wide | Organization rulesets in `rulesets/`, applied only on a paid plan |

Repository-specific checks, such as a build, stay in each repository's branch
protection; the script keeps them when it adds `Codex Code Review`.

## Triggers and commands

Every run starts from a PR comment. Opening, pushing to, reopening or marking
ready a pull request whose branch is in the repository makes triage comment as
gizlet-bot, one command per line, for the new head:

```text
/ci
/codex-review

<sub>Triage for `1a2b3c4`. Comment a command on its own line to run it again.</sub>
<!-- gizlet-triage head_sha=... -->
```

Drafts and fork pull requests get no comment. To run a workflow again, or for
a draft, post a new PR comment with the command on its own line (not quoted
and not in a code block); one comment can hold several commands.

| Command | Effect |
| --- | --- |
| `/ci` | Runs the repository's command-gated CI and reports its check. |
| `/codex-review` | Codex reviews the diff and reports `Codex Code Review`. |

Triage never dispatches a workflow. Each gated workflow listens to
`issue_comment` itself, and every new comment starts it; a job-level `if`
skips comments without its command, so these runs show as skipped. When a
comment holds the command, `pr-check-start.yml` (or the reviewer) accepts it
from a user with `write`, `maintain` or `admin` permission, or from
gizlet-bot, and checks that the PR is open and, for CI, from a branch in the
repository. A gizlet-bot comment applies only to the head in its marker: after
a newer push, the older comment runs nothing. Accepted comments receive 👀 and
then 👍 or 👎 with the result; refused ones receive 😕. Edited comments,
comments from other bots, and comments without a command are ignored.

Every check is attached to the head commit it ran for. A writer can also run a
workflow manually from the Actions tab with a PR number.

## Codex code review

The reviewer only reviews code. It does not evaluate PR titles, descriptions,
or linked Issues. It runs for a `/codex-review` comment, from gizlet-bot on PR
updates or from a writer; a writer can also dispatch it manually. A request for
a head that is no longer the PR head is skipped.

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

1. `start` calls `pr-check-start.yml` for a new PR comment whose body contains
   the command, or for a writer's `workflow_dispatch` with
   `pull_request_number` (and optionally `head_sha`). It authorizes the
   request, refuses fork PRs unless `allow-forks` is true, then creates the
   named check on the PR head.
2. The caller's own job checks out `needs.start.outputs.head_sha` with a
   read-only token and no secrets, and builds or tests it. It runs when
   `start` accepted a request, or for pushes and branch dispatches, where
   `start` is skipped; never for a comment that `start` skipped.
3. `finish` calls `pr-check-finish.yml` with the job result to complete the
   check.

Grant `start` and `finish` `checks: write` and `pull-requests: write` (their
API calls need it), give triage `contents: read` and `pull-requests: read`
(it comments with gizlet-bot's token), and the review caller `checks`,
`issues`, and `pull-requests` write, as in the templates.

Gated workflows have no `pull_request` trigger. Comment and dispatch events
always run the workflow file from the default branch, so a PR cannot weaken its
own required check by editing the workflow. Push builds of the default branch
run the job directly and may save caches; PR builds should only restore them.

## Development

```bash
node --test .github/scripts/pr-command/test.mjs .github/scripts/codex-review/test.mjs
```

After merging a change to `main`, move the tag:

```bash
git tag -f latest origin/main && git push -f origin latest
```
