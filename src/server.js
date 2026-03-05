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
const LOG_LEVEL = (process.env.LOG_LEVEL ?? (LOCAL_TEST_MODE ? "debug" : "info")).toLowerCase();
const LOG_BUFFER_SIZE = Number.parseInt(process.env.LOG_BUFFER_SIZE ?? "500", 10);
const LOG_LOCAL_ENDPOINT =
  process.env.NODE_ENV !== "production" &&
  (process.env.LOG_LOCAL_ENDPOINT === "true" || LOCAL_TEST_MODE);

const LOG_LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const logBuffer = [];

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

function getCurrentIsoTimestamp() {
  return new Date().toISOString();
}

function getLogPriority(level) {
  return LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.info;
}

function shouldLog(level) {
  return getLogPriority(level) >= getLogPriority(LOG_LEVEL);
}

function redactString(input) {
  if (typeof input !== "string") return input;
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-or-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bttc_sk_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}

function sanitizeForLogs(value, keyName = "") {
  const lowerKey = keyName.toLowerCase();
  const sensitiveKeys = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "upstream_api_key",
    "proxy_api_key",
    "token_company_api_key"
  ]);

  if (sensitiveKeys.has(lowerKey)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLogs(item));
  }

  if (typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeForLogs(childValue, childKey);
    }
    return sanitized;
  }

  return String(value);
}

function pushLogEvent(event) {
  logBuffer.push(event);
  const maxSize = Number.isFinite(LOG_BUFFER_SIZE) ? Math.max(1, LOG_BUFFER_SIZE) : 500;
  if (logBuffer.length > maxSize) {
    logBuffer.shift();
  }
}

function logEvent(level, eventName, fields = {}) {
  if (!shouldLog(level)) return;
  const event = sanitizeForLogs({
    timestamp: getCurrentIsoTimestamp(),
    level,
    event_name: eventName,
    service: "token-company-proxy",
    ...fields
  });
  pushLogEvent(event);
  console.log(JSON.stringify(event));
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

function createRequestCompressionState() {
  return {
    enabled: ENABLE_COMPRESSION,
    attempted_count: 0,
    applied_count: 0,
    fallback_count: 0,
    skipped_count: 0,
    input_chars_before: 0,
    input_chars_after: 0,
    reason_codes: []
  };
}

function pushCompressionReason(state, reason) {
  if (!reason) return;
  state.reason_codes.push(reason);
}

async function compressTextSafe(text, requestCompression) {
  if (!ENABLE_COMPRESSION || !TOKEN_COMPANY_API_KEY) return { text, changed: false, reason: "disabled_or_missing_key" };
  if (text.length < COMPRESSION_MIN_CHARS) return { text, changed: false, reason: "below_threshold" };
  if (looksHighRiskForSafeMode(text)) return { text, changed: false, reason: "high_risk_content" };

  stats.compression_attempted_count += 1;
  stats.estimated_input_size_before += text.length;
  requestCompression.attempted_count += 1;
  requestCompression.input_chars_before += text.length;

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
      requestCompression.fallback_count += 1;
      pushCompressionReason(requestCompression, `ttc_http_${response.status}`);
      return { text, changed: false, reason: "ttc_http_error" };
    }

    const payload = await response.json();
    if (!payload || typeof payload.output !== "string") {
      stats.compression_fallback_count += 1;
      stats.last_error_code = "ttc_bad_payload";
      requestCompression.fallback_count += 1;
      pushCompressionReason(requestCompression, "ttc_bad_payload");
      return { text, changed: false, reason: "ttc_bad_payload" };
    }

    stats.estimated_input_size_after += payload.output.length;
    requestCompression.input_chars_after += payload.output.length;

    if (payload.output.length >= text.length) {
      stats.compression_skipped_count += 1;
      requestCompression.skipped_count += 1;
      pushCompressionReason(requestCompression, "no_size_reduction");
      return { text, changed: false, reason: "no_size_reduction" };
    }

    stats.compression_applied_count += 1;
    requestCompression.applied_count += 1;
    pushCompressionReason(requestCompression, "compressed");
    return { text: payload.output, changed: true, reason: "compressed" };
  } catch {
    stats.compression_fallback_count += 1;
    stats.last_error_code = "ttc_request_failed";
    requestCompression.fallback_count += 1;
    pushCompressionReason(requestCompression, "ttc_request_failed");
    return { text, changed: false, reason: "ttc_request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function maybeCompressMessageContent(content, requestCompression) {
  if (typeof content === "string") {
    return compressTextSafe(content, requestCompression);
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
        const compressed = await compressTextSafe(part.text, requestCompression);
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

async function maybeCompressChatPayload(payload, requestCompression) {
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

    const compressed = await maybeCompressMessageContent(message.content, requestCompression);
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
  const traceId = String(req.headers["x-trace-id"] ?? "");
  const requestCompression = createRequestCompressionState();
  stats.requests_total += 1;

  if (!isProxyAuthorized(req)) {
    logEvent("warn", "proxy.request.failed", {
      request_id: requestId,
      trace_id: traceId,
      method: req.method,
      path: req.url,
      status_code: 401,
      outcome: "unauthorized"
    });
    sendJson(res, 401, openAiError("Invalid proxy API key", "authentication_error", "invalid_api_key"));
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    logEvent("warn", "proxy.request.failed", {
      request_id: requestId,
      trace_id: traceId,
      method: req.method,
      path: req.url,
      status_code: 400,
      outcome: "invalid_body"
    });
    sendJson(res, 400, openAiError("Failed to read request body", "invalid_request_error", "invalid_body"));
    return;
  }

  const parsedBody = parseJsonBody(rawBody);
  if (parsedBody) {
    stats.requests_compression_eligible += 1;
    const compressionResult = await maybeCompressChatPayload(parsedBody, requestCompression);
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
    logEvent("error", "proxy.request.failed", {
      request_id: requestId,
      trace_id: traceId,
      method: req.method,
      path: req.url,
      status_code: 500,
      outcome: "missing_upstream_key"
    });
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
    logEvent("error", "proxy.request.failed", {
      request_id: requestId,
      trace_id: traceId,
      method: req.method,
      path: req.url,
      status_code: 502,
      outcome: "upstream_unreachable"
    });
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
  const reductionPct =
    requestCompression.input_chars_before > 0
      ? Number(
          (
            ((requestCompression.input_chars_before - requestCompression.input_chars_after) /
              requestCompression.input_chars_before) *
            100
          ).toFixed(2)
        )
      : 0;

  logEvent("info", "proxy.request.completed", {
    request_id: requestId,
    trace_id: traceId,
    method: req.method,
    path: req.url,
    status_code: upstreamRes.status,
    upstream_status_code: upstreamRes.status,
    duration_ms: durationMs,
    outcome: upstreamRes.status >= 400 ? "upstream_error" : "success",
    compression: {
      enabled: ENABLE_COMPRESSION,
      attempted_count: requestCompression.attempted_count,
      applied_count: requestCompression.applied_count,
      fallback_count: requestCompression.fallback_count,
      skipped_count: requestCompression.skipped_count,
      reason_codes: Array.from(new Set(requestCompression.reason_codes)),
      model: TOKEN_COMPANY_MODEL,
      aggressiveness: TOKEN_COMPANY_AGGRESSIVENESS,
      input_chars_before: requestCompression.input_chars_before,
      input_chars_after: requestCompression.input_chars_after,
      reduction_pct: reductionPct
    }
  });
}

function buildUpstreamChatCompletionsUrl() {
  const base = UPSTREAM_BASE_URL;
  if (base.endsWith("/v1")) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

function getFilteredLogs(urlObj) {
  const level = String(urlObj.searchParams.get("level") ?? "").toLowerCase();
  const requestId = String(urlObj.searchParams.get("request_id") ?? "");
  const since = String(urlObj.searchParams.get("since") ?? "");
  const limitRaw = Number.parseInt(urlObj.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  let filtered = [...logBuffer];
  if (level) {
    filtered = filtered.filter((event) => String(event.level) === level);
  }
  if (requestId) {
    filtered = filtered.filter((event) => String(event.request_id ?? "") === requestId);
  }
  if (since) {
    const sinceTs = Date.parse(since);
    if (!Number.isNaN(sinceTs)) {
      filtered = filtered.filter((event) => {
        const ts = Date.parse(String(event.timestamp ?? ""));
        return Number.isFinite(ts) && ts >= sinceTs;
      });
    }
  }
  return filtered.slice(-limit);
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, openAiError("Invalid request", "invalid_request_error", "bad_request"));
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = urlObj.pathname;

  if (req.method === "GET" && path === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "token-company-proxy",
      milestone: 1
    });
    return;
  }

  if (req.method === "GET" && path === "/stats") {
    sendJson(res, 200, {
      ...stats,
      compression_enabled: ENABLE_COMPRESSION,
      token_company_configured: Boolean(TOKEN_COMPANY_API_KEY),
      compression_roles: Array.from(COMPRESS_ROLES)
    });
    return;
  }

  if (req.method === "GET" && path === "/debug/logs") {
    if (!LOG_LOCAL_ENDPOINT) {
      sendJson(res, 404, openAiError("Endpoint not found", "invalid_request_error", "not_found"));
      return;
    }

    if (!isProxyAuthorized(req)) {
      sendJson(res, 401, openAiError("Invalid proxy API key", "authentication_error", "invalid_api_key"));
      return;
    }

    const events = getFilteredLogs(urlObj);
    sendJson(res, 200, {
      total: logBuffer.length,
      returned: events.length,
      events
    });
    return;
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    await handleChatCompletions(req, res);
    return;
  }

  sendJson(res, 404, openAiError("Endpoint not found", "invalid_request_error", "not_found"));
});

server.listen(PORT, () => {
  logEvent("info", "proxy.server.started", {
    listen_url: `http://localhost:${PORT}`,
    upstream_base_url: UPSTREAM_BASE_URL,
    proxy_auth_required: Boolean(PROXY_API_KEY),
    local_test_mode: LOCAL_TEST_MODE,
    compression_enabled: ENABLE_COMPRESSION,
    log_level: LOG_LEVEL,
    log_local_endpoint_enabled: LOG_LOCAL_ENDPOINT
  });
});
