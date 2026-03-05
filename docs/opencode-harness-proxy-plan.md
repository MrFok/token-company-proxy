# OpenCode Harness Proxy Plan

## Goal

Intercept OpenCode built-in provider traffic (OpenAI OAuth and Z.AI Coding Plan) before upstream model execution, then route through the local TCC proxy.

## Feasibility Findings

- OpenCode supports local/global plugins that run in-process and can change runtime behavior.
- Plugins can execute JavaScript/TypeScript and are loaded at startup.
- Because plugins run in-process, patching `globalThis.fetch` is possible and can intercept provider SDK traffic.
- This approach does not require changing OpenCode source code or forking.

## Constraints

- OpenCode built-in OAuth/provider internals are not guaranteed stable between versions.
- Some providers use non-`/v1` OpenAI-compatible roots (for example Z.AI Coding Plan paths under `/api/coding/paas/v4`).
- Interception must avoid request loops when requests are already targeting local proxy.

## Implementation Strategy

1. Add an OpenCode plugin that patches `globalThis.fetch`.
2. Match outbound requests for known provider base URLs:
   - `https://api.openai.com/v1`
   - `https://api.z.ai/api/coding/paas/v4`
   - `https://api.z.ai/api/paas/v4`
3. Rewrite matching requests to local proxy base (`http://127.0.0.1:8080` by default) while preserving method, headers, body, and query string.
4. Normalize rewritten path to proxy `/v1/*` routes.
5. Keep auth passthrough by not changing `Authorization` header.
6. Add proxy compatibility for non-`/v1` upstream base URLs when routing known endpoints.

## Validation Plan

- Unit/integration test proxy routing for Z.AI coding-style base paths.
- Run OpenCode with plugin enabled and verify proxy `/debug/logs` receives requests.
- Verify both model families route correctly:
  - OpenAI model IDs (`gpt-*`)
  - Z.AI model IDs (`glm-*`)

## Operational Rollout

- Start local proxy in `RELAY_MODE=single_base_url` with provider routing rules.
- Enable plugin in `~/.config/opencode/plugins/`.
- Confirm interception from OpenCode logs and proxy logs.
