const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");
const NETLIFY_BASE = (Netlify.env.get("NETLIFY_URL") || "").replace(/\/$/, "");

const TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;

// فقط این متدها idempotent هستن و می‌شه retry کرد
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "x-forwarded-for",
]);

function buildHeaders(request, clientIp) {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase();
    if (STRIP_HEADERS.has(k)) continue;
    if (k.startsWith("x-nf-") || k.startsWith("x-netlify-")) continue;
    headers.set(k, value);
  }
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  return headers;
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

// ✅ باگ ۳: بازنویسی Location header در redirect‌ها
function rewriteLocationHeader(headers) {
  const location = headers.get("location");
  if (location && TARGET_BASE && NETLIFY_BASE) {
    if (location.startsWith(TARGET_BASE)) {
      headers.set("location", NETLIFY_BASE + location.slice(TARGET_BASE.length));
    }
  }
}

export default async function handler(request, context) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  const { pathname, search } = new URL(request.url);
  const targetUrl = TARGET_BASE + pathname + search;
  const headers = buildHeaders(request, context.ip);
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

  // ✅ باگ ۲: فقط متدهای idempotent رو retry کن
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

      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("transfer-encoding");

      // ✅ باگ ۳: Location رو بازنویسی کن
      rewriteLocationHeader(responseHeaders);

      return new Response(upstream.body, {
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
  // ❌ excludedPath حذف شد — همه فایل‌ها باید proxy بشن
  onError: "bypass",
};
