# cloudflare-security-sync

Cloudflare Worker that receives security sync dispatch requests from the Vercel cron route and enqueues one queue message per owner config.

## Endpoints

- `GET /health` - health check
- `POST /dispatch` - authenticated + signed dispatch endpoint used by Vercel

## Queue

- Producer binding: `SYNC_QUEUE`
- Consumer queue: `security-sync-jobs` (`security-sync-jobs-dev` in dev)
- DLQ: `security-sync-jobs-dlq`

Current consumer implementation validates messages and emits structured logs. Worker-native sync execution is the next phase.
