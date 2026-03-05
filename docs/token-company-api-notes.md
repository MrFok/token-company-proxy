# Token Company API Notes

This file captures implementation details from Token Company docs so we keep API usage consistent.

## Sources
- `https://thetokencompany.com/docs`
- `https://thetokencompany.com/docs/examples`
- `https://thetokencompany.com/docs/protect-text`
- `https://thetokencompany.com/docs/gzip`

## Core Endpoint
- `POST https://api.thetokencompany.com/v1/compress`

## Auth
- Header: `Authorization: Bearer <TOKEN_COMPANY_API_KEY>`

## Request Schema
```json
{
  "model": "bear-1.2",
  "input": "Your text to compress",
  "compression_settings": {
    "aggressiveness": 0.1
  }
}
```

## Response Schema
```json
{
  "output": "Compressed text here",
  "output_tokens": 5,
  "original_input_tokens": 12
}
```

## Model Options
- `bear-1.2` (recommended)
- `bear-1.1`
- `bear-1`

## Gzip Guidance
- Recommended by Token Company for every request.
- Add header `Content-Encoding: gzip` and send gzipped JSON body.
- Keep normal JSON as fallback path if gzip fails.

## Protected Text Guidance
- `<ttc_safe>...</ttc_safe>` can protect content from compression.
- Docs mark this feature as experimental.
- For v1 safe mode, prefer our own masking strategy first, with optional TTC tags as a controlled experiment.

## Proxy Integration Notes (v1)
- Default compression model: `bear-1.2`.
- Default aggressiveness: conservative (start around `0.1` for coding-safe behavior).
- Timeout budget: short bounded timeout; fail-open to original prompt.
- If response fields are missing or malformed, fail-open.

## Open Validation Items
- Docs page references `https://thetokencompany.com/docs/llms.txt` for full index, but this currently returns 404 in our checks.
- Before production hardening, verify any hidden limits (max input size, rate limits) directly with docs/support.
