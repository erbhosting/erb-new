const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");
const NETLIFY_BASE = (Netlify.env.get("URL") || "").replace(/\/$/, "");

const TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// حداکثر 10MB buffer — بیشتر از این رو stream می‌کنیم
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

const STRIP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "x-forwarded-for",
  "accept-encoding",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

function buildRequestHeaders(request, clientIp) {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(k)) continue;
    if (k.startsWith("x-nf-") || k.startsWith("x-netlify-")) continue;
    headers.set(k, value);
  }
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  headers.set("accept-encoding", "identity");
  return headers;
}

function buildResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const [key, value] of upstreamHeaders) {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  return headers;
}

function rewriteLocationHeader(headers) {
  const location = headers.get("location");
  if (location && TARGET_BASE && NETLIFY_BASE && location.startsWith(TARGET_BASE)) {
    headers.set("location", NETLIFY_BASE + location.slice(TARGET_BASE.length));
  }
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ✅ بررسی اینکه response نیاز به buffer داره یا نه
function shouldBuffer(headers) {
  const contentType = headers.get("content-type") || "";
  const contentLength = parseInt(headers.get("content-length") || "0", 10);

  // فایل‌های بزرگ یا binary رو stream کن
  if (contentLength > MAX_BUFFER_SIZE) return false;
  if (contentType.includes("video/") || contentType.includes("audio/")) return false;
  if (contentType.includes("application/octet-stream")) return false;

  // بقیه رو buffer کن
  return true;
}

export default async function handler(request, context) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  const { pathname, search } = new URL(request.url);
  const targetUrl = TARGET_BASE + pathname + search;
  const headers = buildRequestHeaders(request, context.ip);
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  let bodyBuffer = null;
  if (hasBody && request.body) {
    try {
      bodyBuffer = await request.arrayBuffer();
    } catch {
      return new Response("Bad Request: Cannot read body", { status: 400 });
    }
  }

  const canRetry = RETRYABLE_METHODS.has(method);
  const maxAttempts = canRetry ? MAX_RETRIES : 0;
  let lastError;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const upstream = await fetchWithTimeout(
        targetUrl,
        {
          method,
          headers,
          redirect: "manual",
          ...(bodyBuffer !== null && { body: bodyBuffer }),
        },
        TIMEOUT_MS
      );

      const responseHeaders = buildResponseHeaders(upstream.headers);
      rewriteLocationHeader(responseHeaders);

      // ✅ buffer کردن response برای جلوگیری از قطع stream
      let responseBody;
      if (upstream.body && shouldBuffer(upstream.headers)) {
        try {
          const buffered = await upstream.arrayBuffer();
          // content-length درست رو بذار چون حالا می‌دونیم دقیقاً چقدره
          responseHeaders.set("content-length", String(buffered.byteLength));
          responseBody = buffered;
        } catch {
          // اگه buffer کردن fail شد، stream رو مستقیم بفرست
          responseBody = upstream.body;
        }
      } else {
        // فایل‌های بزرگ رو stream کن
        responseBody = upstream.body;
      }

      return new Response(responseBody, {
        status: upstream.status,
        headers: responseHeaders,
      });

    } catch (err) {
      lastError = err;
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      if (isTimeout || attempt === maxAttempts) break;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  const isTimeout = lastError instanceof DOMException && lastError.name === "AbortError";

  context.waitUntil(
    Promise.resolve(
      console.error(`[${context.requestId}] Proxy failed → ${targetUrl}`, lastError)
    )
  );

  return new Response(
    isTimeout ? "Gateway Timeout" : "Bad Gateway",
    { status: isTimeout ? 504 : 502 }
  );
}

export const config = {
  path: "/*",
  onError: "bypass",
};
