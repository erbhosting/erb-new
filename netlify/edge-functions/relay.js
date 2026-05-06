import type { Config, Context } from "@netlify/edge-functions";

const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  // اینا رو Netlify خودش مدیریت می‌کنه
  "x-real-ip", "x-forwarded-for",
]);

function buildHeaders(request: Request, clientIp: string): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase();
    if (STRIP_HEADERS.has(k)) continue;
    if (k.startsWith("x-nf-") || k.startsWith("x-netlify-")) continue;
    headers.set(k, value);
  }
  // ✅ از context.ip استفاده می‌کنیم، دقیق‌تر از header parsing
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  return headers;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(
  request: Request,
  context: Context  // ✅ از Context API استفاده می‌کنیم
) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  const url = new URL(request.url);
  const targetUrl = TARGET_BASE + url.pathname + url.search;

  // ✅ context.ip به جای parse دستی header
  const headers = buildHeaders(request, context.ip);
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  let bodyBuffer: ArrayBuffer | null = null;
  if (hasBody && request.body) {
    try {
      bodyBuffer = await request.arrayBuffer();
    } catch {
      return new Response("Bad Request: Failed to read body", { status: 400 });
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

      const responseHeaders = new Headers();
      for (const [key, value] of upstream.headers) {
        if (key.toLowerCase() === "transfer-encoding") continue;
        responseHeaders.set(key, value);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });

    } catch (error) {
      lastError = error;

      const isTimeout =
        error instanceof DOMException && error.name === "AbortError";

      if (isTimeout || attempt === MAX_RETRIES) break;

      // backoff بین retry‌ها
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  const isTimeout =
    lastError instanceof DOMException && (lastError as DOMException).name === "AbortError";

  // ✅ context.waitUntil برای لاگ بعد از ارسال response
  context.waitUntil(
    Promise.resolve(
      console.error(
        `[${context.requestId}] Relay failed to ${targetUrl}:`,
        lastError
      )
    )
  );

  return new Response(
    isTimeout
      ? "Gateway Timeout: Upstream took too long"
      : "Bad Gateway: Relay Failed",
    { status: isTimeout ? 504 : 502 }
  );
}

// ✅ تعریف path مستقیم در فایل، نیازی به netlify.toml نیست
export const config: Config = {
  path: "/*",
};
