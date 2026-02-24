#!/usr/bin/env bash
# Release IPv4 addresses from all kiloclaw per-user Fly apps.
#
# Iterates over apps matching the acct-* (production) and dev-* (development)
# naming conventions, finds any v4/shared_v4 IP assignments, and releases them.
#
# Usage:
#   ./scripts/release-ipv4.sh                # dry-run (default)
#   ./scripts/release-ipv4.sh --apply        # actually release IPs
#   ./scripts/release-ipv4.sh --org kilo-679 # override org slug
#
# Prerequisites:
#   - flyctl authenticated (`fly auth login`)
#   - jq installed

set -euo pipefail

ORG="kilo-679"
DRY_RUN=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)  DRY_RUN=false; shift ;;
    --org)    ORG="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--apply] [--org <slug>]"
      echo "  --apply   Actually release IPs (default is dry-run)"
      echo "  --org     Fly org slug (default: kilo-679)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required but not installed."; exit 1; }
command -v fly >/dev/null 2>&1 || { echo "ERROR: flyctl (fly) is required but not installed."; exit 1; }

if $DRY_RUN; then
  echo "[DRY RUN] Pass --apply to actually release IPs."
  echo ""
fi

# List all apps in the org, filter to kiloclaw per-user apps (acct-* and dev-*)
APPS=$(fly apps list -o "$ORG" --json 2>/dev/null \
  | jq -r '.[].Name // empty' \
  | grep -E '^(acct|dev)-[0-9a-f]{20}$') || true

if [[ -z "$APPS" ]]; then
  echo "No kiloclaw apps found in org $ORG."
  exit 0
fi

APP_COUNT=$(echo "$APPS" | wc -l | tr -d ' ')
echo "Found $APP_COUNT kiloclaw app(s) in org $ORG."
echo ""

RELEASED=0
SKIPPED=0
ERRORS=0

while IFS= read -r APP; do
  # Get IPs as JSON; skip app on failure (e.g. app in bad state)
  IP_JSON=$(fly ips list -a "$APP" --json 2>/dev/null) || {
    echo "  [$APP] WARN: failed to list IPs, skipping"
    ERRORS=$((ERRORS + 1))
    continue
  }

  # Extract IPv4 addresses (Type contains "v4": covers "v4" and "shared_v4")
  IPV4_ADDRS=$(echo "$IP_JSON" \
    | jq -r '.[] | select(.Type | test("v4")) | .Address') || true

  if [[ -z "$IPV4_ADDRS" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  while IFS= read -r IP; do
    if $DRY_RUN; then
      echo "  [$APP] Would release IPv4: $IP"
    else
      if fly ips release "$IP" -a "$APP" 2>/dev/null; then
        echo "  [$APP] Released IPv4: $IP"
      else
        echo "  [$APP] ERROR: failed to release $IP"
        ERRORS=$((ERRORS + 1))
        continue
      fi
    fi
    RELEASED=$((RELEASED + 1))
  done <<< "$IPV4_ADDRS"
done <<< "$APPS"

echo ""
if $DRY_RUN; then
  echo "Dry run complete: $RELEASED IP(s) would be released, $SKIPPED app(s) had no IPv4, $ERRORS error(s)."
  echo "Run with --apply to execute."
else
  echo "Done: $RELEASED IP(s) released, $SKIPPED app(s) had no IPv4, $ERRORS error(s)."
fi
