#!/usr/bin/env bash
# Smoke-test a built governed-egress proxy image. No provider is contacted:
# the container runs with --network none and a placeholder provider key, so
# this proves the image starts, validates its policy, authenticates callers,
# and ships a working prompt hook. It does NOT prove a release reaches a
# provider (see docs/runbooks/governed-egress-proxy-container.md §5 for the
# end-to-end check against a fake upstream).
#
#   packages/governed-egress/container/smoke-test.sh <image>
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image>}"
NAME="strix-egress-smoke-$$"
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; exit 1; }

# 1. The policy the image ships as its reference (the healthcare reference policy).
docker run --rm --network none --entrypoint node "$IMAGE" -e \
  "import('/app/pkg/src/policy/healthcare-reference-policy.mjs').then(m => process.stdout.write(JSON.stringify(m.HEALTHCARE_REFERENCE_POLICY)))" \
  > "$WORK/policy.json"
chmod 644 "$WORK/policy.json"
[ -s "$WORK/policy.json" ] || fail "could not read the reference policy from the image"

# 2. The prompt hook inside the image: synthetic identifiers block (exit 2)
#    and the value is never echoed; a clean prompt passes (exit 0).
set +e
HOOK_ERR="$(printf '%s' '{"prompt":"Patient: Jane Testcase\nMRN: 00012345"}' \
  | docker run --rm -i --network none --entrypoint node "$IMAGE" /app/pkg/bin/strix-egress-prompt-hook.mjs 2>&1 >/dev/null)"
HOOK_CODE=$?
printf '%s' '{"prompt":"Refactor the retry loop."}' \
  | docker run --rm -i --network none --entrypoint node "$IMAGE" /app/pkg/bin/strix-egress-prompt-hook.mjs >/dev/null 2>&1
CLEAN_CODE=$?
set -e
[ "$HOOK_CODE" = 2 ] || fail "prompt hook did not block synthetic identifiers (exit $HOOK_CODE)"
case "$HOOK_ERR" in *Testcase*|*00012345*) fail "prompt hook echoed a value";; esac
[ "$CLEAN_CODE" = 0 ] || fail "prompt hook blocked a clean prompt (exit $CLEAN_CODE)"

# 3. The proxy starts read-only, unprivileged, with no network, and answers.
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$NAME" --network none \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e STRIX_EGRESS_PROXY_TOKEN="$TOKEN" -e ANTHROPIC_API_KEY=smoke-placeholder-not-a-key \
  -v "$WORK/policy.json:/config/policy.json:ro" \
  "$IMAGE" --provider anthropic >/dev/null

probe() { # $1 = method, $2 = path, $3 = token ('' for none) -> prints status
  docker exec -e T="$3" "$NAME" node -e "
    const h = process.env.T ? { 'x-api-key': process.env.T, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
    const body = '$1' === 'POST' ? JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) : undefined;
    fetch('http://127.0.0.1:8787$2', { method: '$1', headers: h, body })
      .then(r => console.log(r.status)).catch(() => console.log('ERR'));"
}

for _ in $(seq 1 30); do
  [ "$(probe GET /healthz '' 2>/dev/null || true)" = 200 ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "proxy exited at start"
  sleep 1
done
[ "$(probe GET /healthz '')" = 200 ] || fail "/healthz did not answer 200"
[ "$(probe POST /v1/messages '')" = 401 ] || fail "an unauthenticated request was not refused 401"
[ "$(probe POST /v1/messages 'wrong-token-wrong-token-wrong-token')" = 401 ] || fail "a wrong token was not refused 401"
[ "$(docker inspect -f '{{.Config.User}}' "$IMAGE")" = 10001 ] || fail "image does not run as uid 10001"

echo "SMOKE OK: $IMAGE — policy loads, /healthz 200, unauthenticated/wrong-token 401, non-root, prompt hook blocks without echoing and passes a clean prompt."
