#!/usr/bin/env bash
# Pushes the relay image to a private registry that only secrets name:
# RELAY_REGISTRY (host, or host/project), RELAY_REGISTRY_USER, RELAY_REGISTRY_TOKEN,
# and optionally RELAY_IMAGE_PATH (default oob-relay). The tag is the release tag.
# Nothing here prints the registry, the user or the image reference: they are
# masked first, and every command's output goes through a filter that replaces them.
# RELAY_PUSH_DRY_RUN=1 swaps docker for a stand-in that prints the reference, to prove the filter.
set -euo pipefail

reg="${RELAY_REGISTRY:-}"
user="${RELAY_REGISTRY_USER:-}"
token="${RELAY_REGISTRY_TOKEN:-}"
tag="${RELAY_TAG:-}"

if [ -z "$reg" ] || [ -z "$user" ] || [ -z "$token" ]; then
  echo "relay push: not configured, nothing pushed"
  exit 0
fi
if [ -z "$tag" ]; then
  echo "relay push: no release tag"
  exit 1
fi

host="${reg%%/*}"
path="${RELAY_IMAGE_PATH:-oob-relay}"
path="${path#/}"
path="${path%/}"
ref="${reg%/}/$path:$tag"
for v in "$reg" "$host" "$ref" "$user" "$token" "${RELAY_IMAGE_PATH:-}"; do
  [ -z "$v" ] || echo "::add-mask::$v"
done

export M_REF="$ref" M_REG="$reg" M_HOST="$host" M_USER="$user" M_PATH="${RELAY_IMAGE_PATH:-}"
mask() {
  awk '
    function cut(s, t,   o, i) {
      if (t == "") return s
      o = ""
      while ((i = index(s, t)) > 0) { o = o substr(s, 1, i - 1) "***"; s = substr(s, i + length(t)) }
      return o s
    }
    { print cut(cut(cut(cut(cut($0, ENVIRON["M_REF"]), ENVIRON["M_REG"]), ENVIRON["M_PATH"]), ENVIRON["M_HOST"]), ENVIRON["M_USER"]) }'
}

if [ "${RELAY_PUSH_DRY_RUN:-}" = "1" ]; then
  docker() {
    # Read the token like the real login does, or printf can die of SIGPIPE under load.
    [ "$1" != "login" ] || cat >/dev/null
    echo "docker $* (to $ref on $host as $user)"
    [ "${RELAY_PUSH_DRY_RUN_FAIL:-}" != "1" ]
  }
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

printf '%s' "$token" | docker login "$host" --username "$user" --password-stdin 2>&1 | mask
docker buildx build --quiet --progress=quiet \
  --platform linux/amd64,linux/arm64 --provenance=false --sbom=false \
  --tag "$ref" --push "$here/relay" 2>&1 | mask
echo "relay push: done"
