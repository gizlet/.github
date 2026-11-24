#!/usr/bin/env bash
# Applies the gizlet pull-request defaults to the organization.
#
#   scripts/apply-repo-settings.sh [--dry-run] [--include-forks]
#
# Idempotent; run it again after creating a repository or adding the Codex
# review caller to one.
#
# Repository settings (every non-archived repository except forks): squash
# merging only, squash commits use the pull-request title and description, and
# merged branches are deleted. Rulesets cannot set these.
#
# Organization rulesets from rulesets/*.json, created or updated by name:
#   squash-only.json   default branches of all repositories accept squash merges
#                      only through pull requests.
#   codex-review.json  default branches require the `Codex Code Review` check.
#                      Its repository list is filled in with the repositories
#                      whose default branch has a workflow calling the shared
#                      reviewer, so repositories without one are not blocked.
# Organization administrators can bypass both. Organization rulesets need a
# paid plan; on the free plan this step is reported and skipped.
#
# Requires an authenticated gh with organization owner access, and jq.

set -euo pipefail

ORG=gizlet
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REVIEWER='uses:[[:space:]]*(\./\.github/workflows/codex-review\.yml|gizlet/(\.github|github-workflows)/\.github/workflows/codex-review\.yml@)'

dry_run=false
include_forks=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --include-forks) include_forks=true ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

has_reviewer() {
  local repo=$1 branch=$2 path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if gh api "repos/$ORG/$repo/contents/$path?ref=$branch" --jq .content 2>/dev/null \
        | base64 -d 2>/dev/null | grep -Eq "$REVIEWER"; then
      return 0
    fi
  done < <(gh api "repos/$ORG/$repo/contents/.github/workflows?ref=$branch" \
    --jq '.[]|select(.type=="file" and (.name|test("\\.ya?ml$")))|.name|".github/workflows/"+.' 2>/dev/null || true)
  return 1
}

forks=false
$include_forks && forks=true
reviewed=()
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  info=$(gh api "repos/$ORG/$repo")
  branch=$(jq -r .default_branch <<<"$info")
  echo "$ORG/$repo ($(jq -r .visibility <<<"$info"), $branch)"
  echo "  squash only, title + description, delete merged branches"
  if $dry_run; then
    echo "    (dry run)"
  else
    gh api -X PATCH "repos/$ORG/$repo" \
      -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
      -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
      -F delete_branch_on_merge=true >/dev/null
  fi
  if has_reviewer "$repo" "$branch"; then
    echo "  calls the Codex reviewer"
    reviewed+=("$repo")
  fi
done < <(gh repo list "$ORG" --limit 1000 --no-archived \
  --json name,isFork --jq ".[]|select($forks or (.isFork|not))|.name" | sort)

echo "Organization rulesets"
if ! existing=$(gh api "orgs/$ORG/rulesets" --paginate 2>&1); then
  echo "  skipped: $(head -1 <<<"$existing")"
  echo "  Organization rulesets need a paid plan; rerun after upgrading."
  exit 0
fi
for file in "$ROOT"/rulesets/*.json; do
  body=$(cat "$file")
  if [ "$(basename "$file")" = codex-review.json ]; then
    if [ ${#reviewed[@]} -eq 0 ]; then
      echo "  $(jq -r .name <<<"$body"): no repository calls the reviewer; skipped"
      continue
    fi
    body=$(jq --args '.conditions.repository_name.include = $ARGS.positional' <<<"$body" "${reviewed[@]}")
  fi
  name=$(jq -r .name <<<"$body")
  id=$(jq -r --arg name "$name" '.[]|select(.name == $name)|.id' <<<"$existing" | head -1)
  scope=$(jq -r '.conditions.repository_name.include|join(", ")' <<<"$body")
  if [ -n "$id" ]; then
    echo "  update '$name' ($scope)"
    $dry_run || gh api -X PUT "orgs/$ORG/rulesets/$id" --input - <<<"$body" >/dev/null
  else
    echo "  create '$name' ($scope)"
    $dry_run || gh api -X POST "orgs/$ORG/rulesets" --input - <<<"$body" >/dev/null
  fi
done
