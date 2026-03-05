# Architecture Decisions

This file tracks high-impact decisions for v1 in a lightweight ADR style.

## ADR-0001: OpenAI-Compatible Proxy Interface
- **Status:** Accepted
- **Date:** 2026-03-04
- **Context:** Cursor and many tools already support OpenAI-compatible base URLs.
- **Decision:** Build the proxy as an OpenAI-compatible API surface so clients can switch by changing base URL.
- **Consequences:** Faster adoption and lower integration friction; must preserve compatibility details carefully.

## ADR-0002: Safety-First Compression Mode
- **Status:** Accepted
- **Date:** 2026-03-04
- **Context:** Coding workflows are sensitive to subtle prompt corruption.
- **Decision:** Default to conservative safe mode that protects code/structured text and skips uncertain segments.
- **Consequences:** Lower risk of context damage; token savings may be moderate rather than maximal.

## ADR-0003: Fail-Open Compression Behavior
- **Status:** Accepted
- **Date:** 2026-03-04
- **Context:** Proxy must never become a hard dependency that blocks model responses.
- **Decision:** On any compression failure or timeout, forward original payload silently.
- **Consequences:** High reliability and UX continuity; some requests will not realize compression savings.

## ADR-0004: Local-First Then Staging Rollout
- **Status:** Accepted
- **Date:** 2026-03-04
- **Context:** Early value depends on fast real-world iteration in Cursor.
- **Decision:** Validate locally first, then deploy a private hosted staging instance.
- **Consequences:** Faster learning loop; hosted hardening deferred until core behavior is stable.

## ADR-0005: Observability in v1 Without Heavy UI
- **Status:** Accepted
- **Date:** 2026-03-04
- **Context:** Need objective validation of value without building dashboard infrastructure first.
- **Decision:** Include structured logs and lightweight metrics/stats output in v1.
- **Consequences:** Enables measurable evaluation; visualization can be added later.
