const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");
const NETLIFY_BASE = (Netlify.env.get("URL") || "").replace(/\/$/, "");

const TIMEOUT_MS = 25_000; // یه timeout برای کل عملیات (headers + body)
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const STRIP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "x-forwarded-for", "accept-encoding",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "transfer-encoding", "content-encoding", "content-length",
]);

// responses بدون body
const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

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

function rewriteLocation(headers) {
  const loc = headers.get("location");
  if (loc && TARGET_BASE && NETLIFY_BASE && loc.startsWith(TARGET_BASE)) {
    headers.set("location", NETLIFY_BASE + loc.slice(TARGET_BASE.length));
  }
}

export default async function handler(request, context) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  const { pathname, search } = new URL(request.url);
  const targetUrl = TARGET_BASE + pathname + search;
  const method = request.method;

  // یه AbortController برای کل عملیات
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let bodyBuffer = null;
  if (method !== "GET" && method !== "HEAD" && request.body) {
    try {
      bodyBuffer = await request.arrayBuffer();
    } catch {
      clearTimeout(timer);
      return new Response("Bad Request: Cannot read body", { status: 400 });
    }
  }

  const reqHeaders = buildRequestHeaders(request, context.ip);
  const canRetry = RETRYABLE_METHODS.has(method);
  let lastError;

  for (let attempt = 0; attempt <= (canRetry ? 2 : 0); attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 300 * attempt));
      }

      const upstream = await fetch(targetUrl, {
        method,
        headers: reqHeaders,
        redirect: "manual",
        signal: ctrl.signal,
        ...(bodyBuffer !== null && { body: bodyBuffer }),
      });

      const resHeaders = buildResponseHeaders(upstream.headers);
      rewriteLocation(resHeaders);

      // responses بدون body رو همینجا برگردون
      if (NO_BODY_STATUSES.has(upstream.status) || method === "HEAD") {
        clearTimeout(timer);
        return new Response(null, { status: upstream.status, headers: resHeaders });
      }

      // ✅ کل body رو buffer کن — همون AbortController بالا محافظت می‌کنه
      const buffered = await upstream.arrayBuffer();
      clearTimeout(timer);

      resHeaders.set("content-length", String(buffered.byteLength));
      return new Response(buffered, { status: upstream.status, headers: resHeaders });

    } catch (err) {
      lastError = err;
      // فقط اگه timeout نشده retry کن
      if (ctrl.signal.aborted) break;
    }
  }

  clearTimeout(timer);

  context.waitUntil(
    Promise.resolve(
      console.error(`[${context.requestId}] failed → ${targetUrl}`, lastError)
    )
  );

  const isTimeout = ctrl.signal.aborted;
  return new Response(
    isTimeout ? "Gateway Timeout" : "Bad Gateway",
    { status: isTimeout ? 504 : 502 }
  );
}

export const config = {
  path: "/*",
  onError: "bypass",
};
