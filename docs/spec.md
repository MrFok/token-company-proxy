# LLM Compression Proxy v1 Spec

## Problem
IDE and CLI prompts in coding workflows often include large context (files, logs, traces, long chat history), which increases token usage and cost and can hit context limits.

## Product Intent
Build a drop-in OpenAI-compatible proxy that compresses eligible prompt content before forwarding to an upstream model provider.

The product promise for v1 is:

- safe by default
- preserve meaning and coding context over maximal savings
- silent fail-open behavior

## Target Users
- Primary: solo developer (local first)
- Secondary: small teams
- Future: open-source users and hosted customers

## v1 Goals
- Work in Cursor via OpenAI base URL override without IDE changes.
- Support prompt interception and selective compression for text inputs.
- Forward requests to configurable OpenAI-compatible upstream providers.
- Preserve streaming behavior from upstream to client.
- Never block a request if compression fails.

## Non-Goals (v1)
- Multi-tenant billing and account management.
- Advanced UI or dashboard.
- Aggressive compression by default.
- Full provider feature parity beyond core text generation endpoints.

## Scope (v1)
- Endpoint support:
  - `/v1/chat/completions` (required)
  - `/v1/responses` (optional follow-up once stable)
- Compression mode:
  - `safe` mode as default and only fully supported mode in v1
  - future placeholders for `balanced` and `aggressive`
- Behavior:
  - selective compression
  - silent fallback to original prompt on compression errors/timeouts

## Functional Requirements
- OpenAI-compatible request/response pass-through for supported endpoints.
- Configurable upstream base URL and upstream API key.
- Configurable Token Company API key.
- Token Company request format must follow documented API contract for `/v1/compress`.
- Configurable compression thresholds and mode (`safe` default).
- Request-level correlation ID for logging/troubleshooting.
- Basic stats output for local validation.

## Token Company Contract (v1)
- Endpoint: `POST https://api.thetokencompany.com/v1/compress`
- Auth header: `Authorization: Bearer <TOKEN_COMPANY_API_KEY>`
- Request body fields:
  - `model` (default `bear-1.2`)
  - `input` (string)
  - `compression_settings.aggressiveness` (float 0.0-1.0)
- Expected response fields:
  - `output` (compressed text)
  - `output_tokens`
  - `original_input_tokens`
- Optional optimization: gzip request body using `Content-Encoding: gzip`.
- Optional safety control: `<ttc_safe>...</ttc_safe>` tags for protected segments (feature marked experimental in docs).

## Safety Requirements
- Protect high-risk structures from compression in safe mode:
  - fenced code blocks
  - diffs and patches
  - file paths and shell commands
  - JSON/YAML-like structured blocks
  - stack traces
- If uncertainty is high, skip compression for that segment.

## Reliability Requirements
- Fail-open: if compression fails for any reason, forward original content.
- Streaming compatibility: do not buffer full streaming response body.
- Timeouts: compression timeout must be bounded and shorter than upstream request timeout.

## Acceptance Criteria
- Cursor successfully connects using proxy base URL.
- Supported request types return valid upstream responses.
- Streaming responses are forwarded correctly and complete.
- Compression failures do not break request success path.
- Code-heavy prompts remain usable without obvious corruption.
- Validation period shows measurable context reduction on eligible prompts.
