#!/usr/bin/env bash
# Publishes the sold listing tracker's files (state/, sold-listings/, ended/ under $1) to the
# "sold-tracker-data" branch as one fresh orphan commit, force-pushed. Called by the tracker every
# PUBLISH_EVERY_MINUTES while it runs (--publish-cmd) and once more by the workflow at the end.
#
# Safe to run any number of times: each run publishes a full snapshot, so publishing the same state
# again gives the same files, and a failed push leaves the previous snapshot in place. It never
# touches the working tree or the checked-out branch (plumbing commands on a copy), so it can run
# while the tracker is running. vercel.json goes in every commit so Vercel reads its "never deploy"
# rule from the pushed commit itself.
set -euo pipefail

DIR="${1:?usage: publish-sold-tracker.sh <tracker dir>}"
if [ ! -d "$DIR/state" ]; then
  echo "Nothing to publish."
  exit 0
fi

STAGE="$(mktemp -d)"
INDEX="$(mktemp -u)"
trap 'rm -rf "$STAGE" "$INDEX"' EXIT

for d in state sold-listings ended; do
  if [ -d "$DIR/$d" ]; then cp -r "$DIR/$d" "$STAGE/$d"; fi
done
find "$STAGE" -name '*.tmp' -delete
cp vercel.json "$STAGE/vercel.json"

TREE="$(GIT_INDEX_FILE="$INDEX" git --work-tree="$STAGE" add -A -f . && GIT_INDEX_FILE="$INDEX" git write-tree)"
COMMIT="$(git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" \
  commit-tree "$TREE" -m "Update sold listings")"
git push --quiet --force origin "$COMMIT:refs/heads/sold-tracker-data"
echo "Published $COMMIT (tree $TREE)"
