import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

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

async function handleChatCompletions(req, res) {
  const startedAt = Date.now();
  const requestId = randomUUID();

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
});
