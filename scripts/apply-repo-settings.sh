#!/usr/bin/env bash
# Applies the gizlet pull-request defaults to the organization.
#
#   scripts/apply-repo-settings.sh [--dry-run]
#
# Idempotent; run it again after creating a repository or adding the Codex
# review caller to one. Archived repositories are skipped.
#
# Every repository: squash merging only, squash commits use the pull-request
# title and description, auto-merge ("Merge when ready") is allowed, and merged
# branches are deleted.
#
# Public repositories: workflows from outside collaborators' pull requests
# need approval. If the default branch has a workflow calling the shared Codex
# reviewer (forks excluded), branch protection requires the `Codex Code Review`
# check from GitHub Actions, keeping any other required checks, and
# administrators can bypass it. Private repositories cannot use branch
# protection on the free plan.
#
# Organization rulesets from rulesets/*.json are created or updated by name
# when the organization is on a paid plan; otherwise that step is skipped.
#
# Requires an authenticated gh with organization owner access, and jq.

set -euo pipefail

ORG=gizlet
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHECK="Codex Code Review"
ACTIONS_APP_ID=15368
REVIEWER='uses:[[:space:]]*(\./\.github/workflows/codex-review\.yml|gizlet/\.github/\.github/workflows/codex-review\.yml@)'

dry_run=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

gh_write() {
  if $dry_run; then
    echo "    (dry run) gh $*"
  else
    gh "$@" >/dev/null
  fi
}

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

require_check() {
  local repo=$1 branch=$2 protection status checks
  protection="repos/$ORG/$repo/branches/$branch/protection"
  if ! status=$(gh api "$protection" 2>&1); then
    if grep -q "Branch not protected" <<<"$status"; then
      echo "  protect $branch: require '$CHECK', admins may bypass"
      if $dry_run; then
        echo "    (dry run) gh api -X PUT $protection"
      else
        jq -n --arg check "$CHECK" --argjson app "$ACTIONS_APP_ID" '{
          required_status_checks: {strict: false, checks: [{context: $check, app_id: $app}]},
          enforce_admins: false, required_pull_request_reviews: null, restrictions: null
        }' | gh api -X PUT "$protection" --input - >/dev/null
      fi
    else
      echo "  skip protection: $(head -1 <<<"$status")"
    fi
    return
  fi

  if jq -e --arg check "$CHECK" '[.required_status_checks.checks[]? | select(.context == $check)] | length > 0' <<<"$status" >/dev/null; then
    echo "  '$CHECK' already required on $branch"
  else
    echo "  add required check '$CHECK' on $branch"
    checks=$(jq --arg check "$CHECK" --argjson app "$ACTIONS_APP_ID" \
      '[.required_status_checks.checks[]? | {context, app_id}] + [{context: $check, app_id: $app}]' <<<"$status")
    if $dry_run; then
      echo "    (dry run) gh api -X PATCH $protection/required_status_checks"
    else
      jq -n --argjson checks "$checks" --argjson strict "$(jq '.required_status_checks.strict // false' <<<"$status")" \
        '{strict: $strict, checks: $checks}' \
        | gh api -X PATCH "$protection/required_status_checks" --input - >/dev/null
    fi
  fi
  if [ "$(jq -r '.enforce_admins.enabled' <<<"$status")" = true ]; then
    echo "  let admins bypass on $branch"
    gh_write api -X DELETE "$protection/enforce_admins"
  fi
}

reviewed=()
while IFS=$'\t' read -r repo visibility fork; do
  [ -n "$repo" ] || continue
  branch=$(gh api "repos/$ORG/$repo" --jq .default_branch)
  echo "$ORG/$repo ($visibility, $branch$([ "$fork" = true ] && echo ", fork"))"

  echo "  squash only, title + description, allow auto-merge, delete merged branches"
  gh_write api -X PATCH "repos/$ORG/$repo" \
    -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
    -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
    -F allow_auto_merge=true -F delete_branch_on_merge=true

  [ "$visibility" = PUBLIC ] || continue
  echo "  require approval for all outside collaborators' workflows"
  gh_write api -X PUT "repos/$ORG/$repo/actions/permissions/fork-pr-contributor-approval" \
    -f approval_policy=all_external_contributors

  [ "$fork" = false ] || continue
  if has_reviewer "$repo" "$branch"; then
    reviewed+=("$repo")
    require_check "$repo" "$branch"
  else
    echo "  no Codex review caller on $branch; check not required"
  fi
done < <(gh repo list "$ORG" --limit 1000 --no-archived \
  --json name,visibility,isFork --jq '.[]|[.name, .visibility, (.isFork|tostring)]|@tsv' | sort)

echo "Organization rulesets"
if ! existing=$(gh api "orgs/$ORG/rulesets" --paginate 2>&1); then
  echo "  skipped: organization rulesets need a paid plan"
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
