# LLM Compression Proxy v1 Evaluation Plan

## Evaluation Principle
Use eval-driven iteration: test early, test often, and expand cases from real usage logs.

## Primary Questions
- Does the proxy preserve workflow reliability?
- Does safe compression reduce effective input size on eligible prompts?
- Does quality remain stable for coding workflows?

## Test Matrix

## A. Compatibility and Correctness
- Cursor connection and authentication path works with proxy base URL.
- `/v1/chat/completions` non-streaming request/response format stays compatible.
- Upstream errors are passed through in usable form.

## B. Streaming Behavior
- SSE streaming begins promptly and completes without truncation.
- Event ordering and completion markers pass through correctly.
- Proxy does not buffer entire response before forwarding.

## C. Compression Safety
- Prompts containing code blocks preserve exact code sections.
- Diffs/patches preserve hunk syntax and signs (`+`, `-`, `@@`).
- File paths, shell commands, JSON/YAML fragments, and stack traces remain intact.
- If uncertain, segment is skipped rather than aggressively transformed.

## D. Failure and Recovery
- Compression API timeout -> original payload forwarded.
- Compression API error -> original payload forwarded.
- Partial compression failure in a request -> safe fallback behavior.
- Unexpected compression response shape -> safe fallback behavior.

## E. Performance
- Measure added latency from compression path.
- Compare streaming start latency with and without compression.
- Compare compression request performance with and without gzip.

## Metrics
- `compression_attempted_count`
- `compression_applied_count`
- `compression_fallback_count`
- `estimated_input_size_before`
- `estimated_input_size_after`
- `estimated_reduction_percent`
- `compression_added_latency_ms`

## Success Criteria (Two-Week Validation)
- No blocking failures caused by compression path.
- Streaming remains stable during normal Cursor usage.
- Eligible prompts show repeatable input-size reduction.
- No obvious quality regressions in planning/refactor/debug workflows.

## Evaluation Cadence
- Pre-merge smoke tests for compatibility + streaming.
- Daily local usage checks during first week.
- End-of-week review of logs/stats and failure samples.

## Seed Scenarios
- Long planning chat with large context history.
- Refactor request with multiple file snippets.
- Debug prompt with long stack trace and logs.
- Prompt containing mixed prose + structured JSON + code blocks.
