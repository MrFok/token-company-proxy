import test from "node:test";
import assert from "node:assert/strict";

import {
  parseProxyBase,
  parseTargetBases,
  buildProxyPath,
  rewriteUrlToProxy
} from "../opencode-plugins/tcc-proxy-bridge.js";

test("rewrites OpenAI /v1 URLs to proxy /v1", () => {
  const proxyBase = parseProxyBase("http://127.0.0.1:8080");
  const targets = parseTargetBases("https://api.openai.com/v1");
  const rewritten = rewriteUrlToProxy(
    "https://api.openai.com/v1/responses?stream=true",
    proxyBase,
    targets
  );

  assert.equal(rewritten, "http://127.0.0.1:8080/v1/responses?stream=true");
});

test("rewrites Z.AI coding-plan path to proxy /v1", () => {
  const proxyBase = parseProxyBase("http://127.0.0.1:8080");
  const targets = parseTargetBases("https://api.z.ai/api/coding/paas/v4");
  const rewritten = rewriteUrlToProxy(
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
    proxyBase,
    targets
  );

  assert.equal(rewritten, "http://127.0.0.1:8080/v1/chat/completions");
});

test("does not rewrite non-target URLs", () => {
  const proxyBase = parseProxyBase("http://127.0.0.1:8080");
  const targets = parseTargetBases("https://api.openai.com/v1");
  const rewritten = rewriteUrlToProxy(
    "https://example.com/v1/responses",
    proxyBase,
    targets
  );

  assert.equal(rewritten, "https://example.com/v1/responses");
});

test("avoids proxy loop when request already targets proxy", () => {
  const proxyBase = parseProxyBase("http://127.0.0.1:8080/v1");
  const targets = parseTargetBases("https://api.openai.com/v1");
  const rewritten = rewriteUrlToProxy(
    "http://127.0.0.1:8080/v1/chat/completions",
    proxyBase,
    targets
  );

  assert.equal(rewritten, "http://127.0.0.1:8080/v1/chat/completions");
});

test("buildProxyPath preserves /v1 root behavior", () => {
  assert.equal(buildProxyPath("", "/responses"), "/v1/responses");
  assert.equal(buildProxyPath("/v1", "/responses"), "/v1/responses");
  assert.equal(buildProxyPath("/proxy", "/responses"), "/proxy/v1/responses");
});
