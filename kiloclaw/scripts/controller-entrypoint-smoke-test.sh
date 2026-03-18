#!/usr/bin/env bash
set -euo pipefail

# Full entrypoint smoke test — runs the default CMD (controller with bootstrap).
# Tests the complete startup path: bootstrap → onboard/doctor → config patch → gateway.
# For quick controller-only testing, use controller-smoke-test.sh.

IMAGE="${IMAGE:-kiloclaw:controller}"
TOKEN="${TOKEN:-smoke-token}"
PORT="${PORT:-18790}"
KILOCODE_API_KEY="${KILOCODE_API_KEY:-smoke-kilocode-key}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' is not available locally."
  echo "Build it first from the kiloclaw directory:"
  echo "  docker build --progress=plain -t $IMAGE ."
  exit 1
fi

ROOTDIR="$(mktemp -d)"
mkdir -p "$ROOTDIR/.openclaw" "$ROOTDIR/clawd"
cat > "$ROOTDIR/.openclaw/openclaw.json" <<'JSON'
{}
JSON

CID=""
cleanup() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROOTDIR"
}
trap cleanup EXIT

CID=$(docker run -d --rm \
  -p "$PORT:18789" \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e KILOCODE_API_KEY="$KILOCODE_API_KEY" \
  -e REQUIRE_PROXY_TOKEN=true \
  -v "$ROOTDIR:/root" \
  "$IMAGE")

echo "waiting for /_kilo/health on port $PORT ..."
for _ in $(seq 1 60); do
  RESP=$(curl -sS "http://127.0.0.1:${PORT}/_kilo/health" 2>/dev/null) || true
  if echo "$RESP" | grep -q '"state":"ready"'; then
    echo "Controller is ready"
    break
  fi
  # Show bootstrap progress
  STATE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('state','?'), d.get('phase',''))" 2>/dev/null || echo "waiting...")
  echo "  $STATE"
  sleep 1
done

echo
echo "health:"
curl -sS "http://127.0.0.1:${PORT}/_kilo/health"

echo
echo "gateway status (no auth) -> expect 401:"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/_kilo/gateway/status"

echo "gateway status (bearer auth) -> expect 200:"
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/gateway/status"

echo "user traffic without proxy token (REQUIRE_PROXY_TOKEN=true) -> expect 401:"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/"

echo
echo "container logs:"
docker logs --tail 120 "$CID"
