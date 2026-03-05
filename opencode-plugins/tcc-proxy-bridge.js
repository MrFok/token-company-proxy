export function parseTargetBases(rawValue) {
  const defaults = [
    "https://api.openai.com/v1",
    "https://api.z.ai/api/coding/paas/v4",
    "https://api.z.ai/api/paas/v4"
  ];
  const items = String(rawValue ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const list = items.length > 0 ? items : defaults;

  return list
    .map((item) => {
      try {
        const parsed = new URL(item);
        return {
          origin: parsed.origin,
          pathname: parsed.pathname.replace(/\/$/, "") || "/"
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function parseProxyBase(rawValue) {
  const parsed = new URL(String(rawValue ?? "http://127.0.0.1:8080").trim());
  return {
    origin: parsed.origin,
    pathname: parsed.pathname.replace(/\/$/, "") || ""
  };
}

function normalizeSuffixPath(pathname, matchedBasePath) {
  const suffixPath = pathname.slice(matchedBasePath.length) || "/";
  return suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
}

function isSubPath(pathname, basePath) {
  if (basePath === "/") return true;
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function buildProxyPath(proxyBasePath, suffixPath) {
  const suffix = suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
  const normalizedSuffix = suffix === "/" ? "" : suffix;
  const proxyRoot = proxyBasePath || "";
  if (proxyRoot.endsWith("/v1")) {
    return `${proxyRoot}${normalizedSuffix}` || "/v1";
  }
  if (!proxyRoot) {
    return `/v1${normalizedSuffix}`;
  }
  return `${proxyRoot}/v1${normalizedSuffix}`;
}

export function rewriteUrlToProxy(rawUrl, proxyBase, targetBases) {
  const url = new URL(rawUrl);
  if (url.origin === proxyBase.origin && isSubPath(url.pathname, proxyBase.pathname || "/")) {
    return rawUrl;
  }

  for (const target of targetBases) {
    if (url.origin !== target.origin || !isSubPath(url.pathname, target.pathname)) {
      continue;
    }
    const suffix = normalizeSuffixPath(url.pathname, target.pathname);
    const proxyPath = buildProxyPath(proxyBase.pathname, suffix);
    return `${proxyBase.origin}${proxyPath}${url.search}`;
  }

  return rawUrl;
}

async function proxyBridgeFetch({ input, init, getAuth, proxyBase, targetBases, debug, providerId }) {
  const request = new Request(input, init);
  const rewrittenUrl = rewriteUrlToProxy(request.url, proxyBase, targetBases);
  const auth = await getAuth();

  const rewrittenRequest = new Request(rewrittenUrl, request);
  const authType = String(auth?.type ?? "").toLowerCase();
  const token = authType === "oauth"
    ? String(auth?.access ?? "")
    : authType === "api"
      ? String(auth?.key ?? "")
      : "";

  if (token) {
    rewrittenRequest.headers.set("authorization", `Bearer ${token}`);
  }
  rewrittenRequest.headers.set("x-opencode-proxy-bridge", "1");
  rewrittenRequest.headers.set("x-opencode-provider", providerId);

  if (debug && rewrittenUrl !== request.url) {
    console.error(`[tcc-proxy-bridge:${providerId}] ${request.url} -> ${rewrittenUrl}`);
  }

  return fetch(rewrittenRequest);
}

function createBridgeFetch({ originalFetch, proxyBase, targetBases, debug }) {
  return async function bridgeFetch(input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === proxyBase.origin && isSubPath(url.pathname, proxyBase.pathname || "/")) {
      return originalFetch(request);
    }

    for (const target of targetBases) {
      if (url.origin !== target.origin || !isSubPath(url.pathname, target.pathname)) {
        continue;
      }

      const suffixPath = url.pathname.slice(target.pathname.length) || "/";
      const proxyPath = buildProxyPath(proxyBase.pathname, suffixPath);
      const rewrittenUrl = `${proxyBase.origin}${proxyPath}${url.search}`;

      if (debug) {
        console.error(`[tcc-proxy-bridge] ${url.toString()} -> ${rewrittenUrl}`);
      }

      const rewrittenRequest = new Request(rewrittenUrl, request);
      rewrittenRequest.headers.set("x-opencode-proxy-bridge", "1");
      return originalFetch(rewrittenRequest);
    }

    return originalFetch(request);
  };
}

export const TccProxyBridgePlugin = async ({ client }) => {
  if (globalThis.__TCC_PROXY_BRIDGE_INSTALLED__) {
    return {};
  }

  const proxyBase = parseProxyBase(process.env.OC_PROXY_BRIDGE_BASE_URL);
  const targetBases = parseTargetBases(process.env.OC_PROXY_BRIDGE_TARGETS);
  const debug = process.env.OC_PROXY_BRIDGE_DEBUG === "true";
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = createBridgeFetch({
    originalFetch,
    proxyBase,
    targetBases,
    debug
  });

  globalThis.__TCC_PROXY_BRIDGE_INSTALLED__ = true;

  await client.app.log({
    body: {
      service: "tcc-proxy-bridge",
      level: "info",
      message: "Installed fetch bridge for OpenCode provider traffic",
      extra: {
        proxyBaseUrl: `${proxyBase.origin}${proxyBase.pathname || ""}`,
        targetBases: targetBases.map((target) => `${target.origin}${target.pathname}`)
      }
    }
  });

  return {};
};

export const OpenAIProxyAuthBridgePlugin = async ({ client }) => {
  const proxyBase = parseProxyBase(process.env.OC_PROXY_BRIDGE_BASE_URL);
  const targetBases = parseTargetBases(process.env.OC_PROXY_BRIDGE_TARGETS);
  const debug = process.env.OC_PROXY_BRIDGE_DEBUG === "true";

  return {
    auth: {
      provider: "openai",
      async loader(getAuth) {
        await client.app.log({
          body: {
            service: "tcc-proxy-bridge",
            level: "info",
            message: "Enabled OpenAI auth bridge",
            extra: {
              provider: "openai"
            }
          }
        });

        return {
          apiKey: "",
          async fetch(input, init) {
            return proxyBridgeFetch({
              input,
              init,
              getAuth,
              proxyBase,
              targetBases,
              debug,
              providerId: "openai"
            });
          }
        };
      }
    }
  };
};

export const ZaiCodingPlanProxyAuthBridgePlugin = async ({ client }) => {
  const proxyBase = parseProxyBase(process.env.OC_PROXY_BRIDGE_BASE_URL);
  const targetBases = parseTargetBases(process.env.OC_PROXY_BRIDGE_TARGETS);
  const debug = process.env.OC_PROXY_BRIDGE_DEBUG === "true";

  return {
    auth: {
      provider: "zai-coding-plan",
      async loader(getAuth) {
        await client.app.log({
          body: {
            service: "tcc-proxy-bridge",
            level: "info",
            message: "Enabled Z.AI Coding Plan auth bridge",
            extra: {
              provider: "zai-coding-plan"
            }
          }
        });

        return {
          apiKey: "",
          async fetch(input, init) {
            return proxyBridgeFetch({
              input,
              init,
              getAuth,
              proxyBase,
              targetBases,
              debug,
              providerId: "zai-coding-plan"
            });
          }
        };
      }
    }
  };
};

export default TccProxyBridgePlugin;
