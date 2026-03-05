# token-company-proxy

OpenAI-compatible proxy for IDE workflows (Cursor-compatible) that can apply safe prompt compression before forwarding requests to an upstream model provider.

## Current Status
- Milestone 1 implemented: baseline pass-through proxy
- Milestone 2 implemented: safe-mode selective compression with fail-open fallback

## Milestone 1 Features
- `POST /v1/chat/completions` OpenAI-compatible pass-through
- Streaming pass-through (no full response buffering)
- Configurable upstream (`UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`)
- Optional proxy auth (`PROXY_API_KEY`)
- Health endpoint at `GET /healthz`

## Milestone 2 Features
- Safe-mode selective compression for `/v1/chat/completions` request messages
- Conservative default: compress only `user` role content (`COMPRESS_ROLES` configurable)
- High-risk content skip heuristics (code fences, diffs, stack traces, likely structured blobs)
- Fail-open behavior for all compression errors/timeouts
- Token Company integration with optional gzip requests
- Stats endpoint at `GET /stats` (no prompt content)
- Local structured logs endpoint at `GET /debug/logs` (local mode only)

## Quick Start
1. Copy env file and set keys:
   - `cp .env.example .env.local`
   - Set `UPSTREAM_API_KEY`
2. Start server:
   - `npm start`
3. Configure Cursor:
   - Base URL: `http://localhost:8080/v1`
   - API Key: `anything` (or your `PROXY_API_KEY` if enabled)

## Environment Variables
- `PORT` (default `8080`)
- `UPSTREAM_BASE_URL` (default `https://api.openai.com`)
- `UPSTREAM_API_KEY` (recommended; if empty, proxy forwards client Bearer token)
- `PROXY_API_KEY` (optional, enables proxy-level auth)
- `TOKEN_COMPANY_API_KEY` (used in Milestone 2)
- `LOCAL_TEST_MODE` (`true` enables `.env.local` preference)
- `ENABLE_COMPRESSION` (`true`/`false`)
- `TOKEN_COMPANY_BASE_URL` (default `https://api.thetokencompany.com`)
- `TOKEN_COMPANY_MODEL` (default `bear-1.2`)
- `TOKEN_COMPANY_AGGRESSIVENESS` (default `0.1`)
- `TOKEN_COMPANY_TIMEOUT_MS` (default `2500`)
- `TOKEN_COMPANY_USE_GZIP` (default `true`)
- `COMPRESSION_MIN_CHARS` (default `500`)
- `COMPRESS_ROLES` (comma-separated, default `user`)
- `LOG_LEVEL` (`debug|info|warn|error`)
- `LOG_BUFFER_SIZE` (in-memory log ring size, default `500`)
- `LOG_LOCAL_ENDPOINT` (enable `GET /debug/logs` in non-production)

## Local Test Mode
- When `LOCAL_TEST_MODE=true` (or when `.env.local` exists and `NODE_ENV` is not `production`), the proxy loads `.env.local` first.
- `.env` is also loaded as fallback for missing values.
- Existing shell environment variables still take priority over file values.

## OpenRouter Example
Use OpenRouter as upstream by setting:

```env
UPSTREAM_BASE_URL=https://openrouter.ai/api
UPSTREAM_API_KEY=<openrouter_key>
```

Then send a request through the proxy using your model name, for example:

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -d '{
    "model": "arcee-ai/trinity-large-preview:free",
    "messages": [
      {"role": "user", "content": "Say hello in one sentence."}
    ]
  }'
```

## Notes
- Upstream compatibility target is currently `/v1/chat/completions`.
- Compression path is intentionally conservative for coding safety.
- `.env.local` remains ignored and should never be committed.

## Local Logs Endpoint
- Endpoint: `GET /debug/logs`
- Available only when `LOG_LOCAL_ENDPOINT=true` and not in production.
- Requires proxy auth if `PROXY_API_KEY` is configured.
- Query params:
  - `level` (`debug|info|warn|error`)
  - `request_id`
  - `since` (ISO timestamp)
  - `limit` (max `200`)

## Planning Docs
- `docs/spec.md`
- `docs/implementation-plan.md`
- `docs/evaluation-plan.md`
- `docs/decisions.md`
- `docs/token-company-api-notes.md`
- `docs/logging-instructions.txt`
