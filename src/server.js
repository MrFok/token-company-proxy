import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

function parseDotenv(fileContent) {
  const result = {};
  const lines = fileContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadEnvFile(fileName) {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) return;
  const parsed = parseDotenv(readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadEnvironment() {
  const explicitLocalMode = process.env.LOCAL_TEST_MODE === "true" || process.env.LOCAL_TEST_MODE === "1";
  const inferredLocalMode = process.env.NODE_ENV !== "production" && existsSync(resolve(process.cwd(), ".env.local"));
  const localMode = explicitLocalMode || inferredLocalMode;
  if (localMode) {
    loadEnvFile(".env.local");
  }
  loadEnvFile(".env");
  return localMode;
}

const LOCAL_TEST_MODE = loadEnvironment();

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY ?? "";
const ENABLE_COMPRESSION = process.env.ENABLE_COMPRESSION !== "false";
const TOKEN_COMPANY_API_KEY = process.env.TOKEN_COMPANY_API_KEY ?? "";
const TOKEN_COMPANY_BASE_URL = (process.env.TOKEN_COMPANY_BASE_URL ?? "https://api.thetokencompany.com").replace(/\/$/, "");
const TOKEN_COMPANY_MODEL = process.env.TOKEN_COMPANY_MODEL ?? "bear-1.2";
const TOKEN_COMPANY_AGGRESSIVENESS = Number.parseFloat(process.env.TOKEN_COMPANY_AGGRESSIVENESS ?? "0.1");
const TOKEN_COMPANY_TIMEOUT_MS = Number.parseInt(process.env.TOKEN_COMPANY_TIMEOUT_MS ?? "2500", 10);
const TOKEN_COMPANY_USE_GZIP = process.env.TOKEN_COMPANY_USE_GZIP !== "false";
const COMPRESSION_MIN_CHARS = Number.parseInt(process.env.COMPRESSION_MIN_CHARS ?? "500", 10);
const COMPRESS_ROLES = new Set(
  (process.env.COMPRESS_ROLES ?? "user")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const stats = {
  requests_total: 0,
  requests_compression_eligible: 0,
  requests_compression_applied: 0,
  compression_attempted_count: 0,
  compression_applied_count: 0,
  compression_fallback_count: 0,
  compression_skipped_count: 0,
  estimated_input_size_before: 0,
  estimated_input_size_after: 0,
  last_error_code: null
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function openAiError(message, type = "invalid_request_error", code = null) {
  return {
    error: {
      message,
      type,
      code
    }
  };
}

function getBearerToken(authorizationHeader) {
  if (!authorizationHeader) return "";
  const [scheme, token] = authorizationHeader.split(" ");
  if (!scheme || !token) return "";
  if (scheme.toLowerCase() !== "bearer") return "";
  return token;
}

function isProxyAuthorized(req) {
  if (!PROXY_API_KEY) return true;
  const token = getBearerToken(req.headers.authorization);
  return token === PROXY_API_KEY;
}

function buildUpstreamHeaders(req, requestId, contentLength) {
  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)) continue;
    if (lowerName === "authorization") continue;
    if (lowerName === "content-length") continue;
    headers[name] = Array.isArray(value) ? value.join(",") : value;
  }

  headers["x-proxy-request-id"] = requestId;
  headers["content-length"] = String(contentLength);

  const clientToken = getBearerToken(req.headers.authorization);
  const upstreamToken = UPSTREAM_API_KEY || clientToken;

  if (!upstreamToken) {
    throw new Error("Missing upstream API key. Set UPSTREAM_API_KEY or pass client Authorization header.");
  }

  headers.authorization = `Bearer ${upstreamToken}`;
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  return headers;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function copyUpstreamHeaders(upstreamRes, clientRes) {
  for (const [name, value] of upstreamRes.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    clientRes.setHeader(name, value);
  }
}

function parseJsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function looksHighRiskForSafeMode(text) {
  if (!text) return false;
  const highRiskPatterns = [
    /```/, // fenced code
    /^diff --git/m,
    /^@@\s/m,
    /^\+\+\+\s/m,
    /^---\s/m,
    /Traceback \(most recent call last\):/,
    /Exception:/,
    /^\s*\{[\s\S]*\}\s*$/m,
    /^\s*\[[\s\S]*\]\s*$/m
  ];
  return highRiskPatterns.some((pattern) => pattern.test(text));
}

function buildTokenCompanyCompressUrl() {
  const base = TOKEN_COMPANY_BASE_URL;
  if (base.endsWith("/v1")) {
    return `${base}/compress`;
  }
  return `${base}/v1/compress`;
}

async function compressTextSafe(text) {
  if (!ENABLE_COMPRESSION || !TOKEN_COMPANY_API_KEY) return { text, changed: false, reason: "disabled_or_missing_key" };
  if (text.length < COMPRESSION_MIN_CHARS) return { text, changed: false, reason: "below_threshold" };
  if (looksHighRiskForSafeMode(text)) return { text, changed: false, reason: "high_risk_content" };

  stats.compression_attempted_count += 1;
  stats.estimated_input_size_before += text.length;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_COMPANY_TIMEOUT_MS);
  try {
    const requestPayload = {
      model: TOKEN_COMPANY_MODEL,
      input: text,
      compression_settings: {
        aggressiveness: Number.isFinite(TOKEN_COMPANY_AGGRESSIVENESS) ? TOKEN_COMPANY_AGGRESSIVENESS : 0.1
      }
    };

    let body;
    const headers = {
      authorization: `Bearer ${TOKEN_COMPANY_API_KEY}`,
      "content-type": "application/json"
    };

    if (TOKEN_COMPANY_USE_GZIP) {
      headers["content-encoding"] = "gzip";
      body = gzipSync(Buffer.from(JSON.stringify(requestPayload), "utf8"));
    } else {
      body = JSON.stringify(requestPayload);
    }

    const response = await fetch(buildTokenCompanyCompressUrl(), {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      stats.compression_fallback_count += 1;
      stats.last_error_code = `ttc_http_${response.status}`;
      return { text, changed: false, reason: "ttc_http_error" };
    }

    const payload = await response.json();
    if (!payload || typeof payload.output !== "string") {
      stats.compression_fallback_count += 1;
      stats.last_error_code = "ttc_bad_payload";
      return { text, changed: false, reason: "ttc_bad_payload" };
    }

    stats.estimated_input_size_after += payload.output.length;

    if (payload.output.length >= text.length) {
      stats.compression_skipped_count += 1;
      return { text, changed: false, reason: "no_size_reduction" };
    }

    stats.compression_applied_count += 1;
    return { text: payload.output, changed: true, reason: "compressed" };
  } catch {
    stats.compression_fallback_count += 1;
    stats.last_error_code = "ttc_request_failed";
    return { text, changed: false, reason: "ttc_request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function maybeCompressMessageContent(content) {
  if (typeof content === "string") {
    return compressTextSafe(content);
  }

  if (Array.isArray(content)) {
    let anyChanged = false;
    const next = [];

    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        const compressed = await compressTextSafe(part.text);
        next.push({ ...part, text: compressed.text });
        if (compressed.changed) anyChanged = true;
      } else {
        next.push(part);
      }
    }

    return { text: next, changed: anyChanged, reason: anyChanged ? "compressed" : "unchanged" };
  }

  return { text: content, changed: false, reason: "unsupported_content" };
}

async function maybeCompressChatPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
    return { payload, changed: false };
  }

  let changed = false;
  const nextMessages = [];

  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      nextMessages.push(message);
      continue;
    }

    if (!COMPRESS_ROLES.has(String(message.role ?? ""))) {
      nextMessages.push(message);
      continue;
    }

    const compressed = await maybeCompressMessageContent(message.content);
    nextMessages.push({ ...message, content: compressed.text });
    if (compressed.changed) {
      changed = true;
    }
  }

  if (!changed) {
    return { payload, changed: false };
  }

  return {
    payload: {
      ...payload,
      messages: nextMessages
    },
    changed: true
  };
}

async function handleChatCompletions(req, res) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  stats.requests_total += 1;

  if (!isProxyAuthorized(req)) {
    sendJson(res, 401, openAiError("Invalid proxy API key", "authentication_error", "invalid_api_key"));
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 400, openAiError("Failed to read request body", "invalid_request_error", "invalid_body"));
    return;
  }

  const parsedBody = parseJsonBody(rawBody);
  if (parsedBody) {
    stats.requests_compression_eligible += 1;
    const compressionResult = await maybeCompressChatPayload(parsedBody);
    if (compressionResult.changed) {
      rawBody = Buffer.from(JSON.stringify(compressionResult.payload), "utf8");
      stats.requests_compression_applied += 1;
    }
  }

  const upstreamUrl = buildUpstreamChatCompletionsUrl();
  let upstreamHeaders;
  try {
    upstreamHeaders = buildUpstreamHeaders(req, requestId, rawBody.byteLength);
  } catch (error) {
    sendJson(res, 500, openAiError(error.message, "server_error", "upstream_key_missing"));
    return;
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: rawBody
    });
  } catch {
    sendJson(res, 502, openAiError("Upstream request failed", "api_error", "upstream_unreachable"));
    return;
  }

  res.statusCode = upstreamRes.status;
  copyUpstreamHeaders(upstreamRes, res);
  res.setHeader("x-proxy-request-id", requestId);

  const responseBody = upstreamRes.body;
  if (!responseBody) {
    res.end();
  } else {
    Readable.fromWeb(responseBody).pipe(res);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    JSON.stringify({
      request_id: requestId,
      method: req.method,
      path: req.url,
      upstream_status: upstreamRes.status,
      duration_ms: durationMs
    })
  );
}

function buildUpstreamChatCompletionsUrl() {
  const base = UPSTREAM_BASE_URL;
  if (base.endsWith("/v1")) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, openAiError("Invalid request", "invalid_request_error", "bad_request"));
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "token-company-proxy",
      milestone: 1
    });
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    sendJson(res, 200, {
      ...stats,
      compression_enabled: ENABLE_COMPRESSION,
      token_company_configured: Boolean(TOKEN_COMPANY_API_KEY),
      compression_roles: Array.from(COMPRESS_ROLES)
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    await handleChatCompletions(req, res);
    return;
  }

  sendJson(res, 404, openAiError("Endpoint not found", "invalid_request_error", "not_found"));
});

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
  console.log(`Upstream base URL: ${UPSTREAM_BASE_URL}`);
  console.log(`Proxy auth required: ${PROXY_API_KEY ? "yes" : "no"}`);
  console.log(`Local test mode: ${LOCAL_TEST_MODE ? "enabled" : "disabled"}`);
  console.log(`Compression enabled: ${ENABLE_COMPRESSION ? "yes" : "no"}`);
});
