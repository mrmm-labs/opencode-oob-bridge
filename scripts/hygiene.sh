#!/usr/bin/env bash
# Fails when a tracked file or a commit message holds a word of the deny-list.
# The list is .github/hygiene-denylist.txt plus the HYGIENE_DENYLIST secret
# (one word per line). Only file:line is printed, never the word.
# HYGIENE_BASE, when set, is the commit before the change: its messages are checked too.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
{
  cat .github/hygiene-denylist.txt 2>/dev/null || true
  printf '%s\n' "${HYGIENE_DENYLIST:-}"
} | sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v -e '^$' -e '^#' >"$list" || true

if [ ! -s "$list" ]; then
  echo "hygiene: the deny-list is empty"
  exit 1
fi

found=0
files="$(git grep -n -I -i -F -f "$list" -- . ':(exclude).github/hygiene-denylist.txt' | cut -d: -f1,2 || true)"
if [ -n "$files" ]; then
  found=1
  echo "hygiene: a deny-listed word is in:"
  echo "$files" | sed 's/^/  /'
fi

if [ -n "${HYGIENE_BASE:-}" ]; then
  for c in $(git rev-list "$HYGIENE_BASE..HEAD"); do
    if git log -1 --format=%B "$c" | grep -q -i -F -f "$list"; then
      found=1
      echo "hygiene: a deny-listed word is in the message of commit $(git rev-parse --short "$c")"
    fi
  done
fi

if [ "$found" -ne 0 ]; then
  echo "hygiene: the words are not printed; look at the lines above"
  exit 1
fi
echo "hygiene: clean"
