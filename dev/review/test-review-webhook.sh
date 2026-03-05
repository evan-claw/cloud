#!/usr/bin/env bash
set -euo pipefail

# Intentionally generic test payload.
# Ask an AI to replace with a real webhook payload captured from smee.io.

WEBHOOK_URL="${WEBHOOK_URL:-http://127.0.0.1:3000/api/webhooks/github}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dausigdb781g287d9asgd9721dsa}"
EVENT_TYPE="${EVENT_TYPE:-pull_request}"
DELIVERY_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

# Optional first arg: path to JSON file containing a real GitHub webhook body.
PAYLOAD_FILE="${1:-}"

GENERIC_BODY='{
  "action": "opened",
  "number": 123,
  "pull_request": {
    "number": 123,
    "title": "PLACEHOLDER: Replace with real PR title",
    "body": "PLACEHOLDER: Replace with real PR body",
    "state": "open",
    "draft": false,
    "html_url": "https://github.com/OWNER/REPO/pull/123",
    "user": {
      "id": 1,
      "login": "octocat",
      "avatar_url": "https://github.com/images/error/octocat_happy.gif"
    },
    "head": {
      "sha": "1111111111111111111111111111111111111111",
      "ref": "feature/placeholder",
      "repo": {
        "full_name": "OWNER/REPO"
      }
    },
    "base": {
      "sha": "2222222222222222222222222222222222222222",
      "ref": "main"
    }
  },
  "repository": {
    "id": 1,
    "name": "REPO",
    "full_name": "OWNER/REPO",
    "private": false,
    "owner": {
      "login": "OWNER"
    }
  },
  "installation": {
    "id": 12345678
  },
  "sender": {
    "login": "octocat"
  }
}'

if [ -n "$PAYLOAD_FILE" ]; then
  RAW_BODY="$(cat "$PAYLOAD_FILE")"
  PAYLOAD_SOURCE="$PAYLOAD_FILE"
else
  RAW_BODY="$GENERIC_BODY"
  PAYLOAD_SOURCE="embedded generic payload"
fi

# Support envelope payloads like {"event":"...","payload":{...}}.
BODY="$(printf '%s' "$RAW_BODY" | jq -c 'if (type == "object" and has("payload")) then .payload else . end')"

SIGNATURE="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"

echo "Delivery ID:   $DELIVERY_ID"
echo "Event:         $EVENT_TYPE"
echo "URL:           $WEBHOOK_URL"
echo "Payload source:$PAYLOAD_SOURCE"
echo "Signature:     $SIGNATURE"
echo
echo "Sending webhook..."
echo

curl -s -w "\nHTTP Status: %{http_code}\n" -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-github-event: $EVENT_TYPE" \
  -H "x-github-delivery: $DELIVERY_ID" \
  -H "x-hub-signature-256: $SIGNATURE" \
  -d "$BODY"

echo
echo "Done."
