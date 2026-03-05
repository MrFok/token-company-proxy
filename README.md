# token-company-proxy

OpenAI-compatible proxy for IDE workflows (Cursor-compatible) that can apply safe prompt compression before forwarding requests to an upstream model provider.

## Current Status
- Milestone 1 implemented: baseline pass-through proxy
- Compression not yet enabled (Milestone 2)

## Milestone 1 Features
- `POST /v1/chat/completions` OpenAI-compatible pass-through
- Streaming pass-through (no full response buffering)
- Configurable upstream (`UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`)
- Optional proxy auth (`PROXY_API_KEY`)
- Health endpoint at `GET /healthz`

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
- This milestone is pass-through only. No prompt compression is applied yet.
- Upstream compatibility target for this milestone is `/v1/chat/completions`.
- `TOKEN_COMPANY_API_KEY` is used in Milestone 2 (compression), not Milestone 1.

## Planning Docs
- `docs/spec.md`
- `docs/implementation-plan.md`
- `docs/evaluation-plan.md`
- `docs/decisions.md`
- `docs/token-company-api-notes.md`
