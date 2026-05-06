import type { Config, Context } from "@netlify/edge-functions";

const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");

// ✅ timeout طراحی‌شده بر اساس سقف 40s Netlify:
// 12s + 0.2s + 12s + 0.4s + 12s = ~36.6s (زیر سقف 40s)
const TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "x-forwarded-for", // Netlify از context.ip مدیریت می‌کنه
]);

function buildHeaders(request: Request, clientIp: string): Headers {
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

async function fetchWithTimeout(url: string, options: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(request: Request, context: Context) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  const { pathname, search } = new URL(request.url);
  const targetUrl = TARGET_BASE + pathname + search;
  const headers = buildHeaders(request, context.ip);
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  let bodyBuffer: ArrayBuffer | null = null;
  if (hasBody && request.body) {
    try {
      bodyBuffer = await request.arrayBuffer();
    } catch {
      return new Response("Bad Request: Cannot read body", { status: 400 });
    }
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });

    } catch (err) {
      lastError = err;
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      if (isTimeout || attempt === MAX_RETRIES) break;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  const isTimeout = lastError instanceof DOMException &&
    (lastError as DOMException).name === "AbortError";

  // لاگ background بعد از ارسال response
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

export const config: Config = {
  path: "/*",
  // ✅ فایل‌های static نیازی به proxy ندارن
  excludedPath: ["/*.css", "/*.js", "/*.png", "/*.jpg", "/*.svg", "/*.ico", "/*.woff2"],
  // ✅ در صورت crash کامل function، به origin برگرد
  onError: "bypass",
};
