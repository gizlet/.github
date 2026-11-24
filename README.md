# gizlet/.github

Organization defaults for gizlet repositories.

## Workflow templates

`workflow-templates/` holds the callers of the shared
[gizlet/github-workflows](https://github.com/gizlet/github-workflows). In a
repository, open **Actions → New workflow** and pick them from the
"By gizlet" section.

| Template | File in the repository | Required check |
| --- | --- | --- |
| Gizlet PR triage | `.github/workflows/triage.yml` | — |
| Gizlet Codex review | `.github/workflows/codex-review.yml` | `Codex Code Review` |
| Gizlet gated CI | `.github/workflows/ci.yml` | `CI` |

Add all three to a repository:

1. In `ci.yml`, replace the placeholder `Build and test` step with the
   repository's build and test commands. It fails until replaced. Rename the
   file or the `check-name` only together with `workflows:` in `triage.yml`
   and the branch protection rule.
2. In `codex-review.yml`, describe the repository in `review-instructions`.
3. Merge to the default branch. Triggers run the default-branch copy, so the
   pull request that adds them cannot run them.
4. In branch protection, require `Codex Code Review` and `CI` (source: GitHub
   Actions).
5. Optionally set the `BUILD_RUNNER` repository variable to a self-hosted
   runner for the build job. Triage and review always run on GitHub-hosted
   runners.

The `OPENAI_API_KEY` organization secret is available to every repository.
Behavior, commands (`/test`, `/codex-review`) and security notes are in the
[shared workflows README](https://github.com/gizlet/github-workflows#readme).
