const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const SAFE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];
const QUERY_KEYS = new Set(["types","source","id","name","artist","album","br","format","keyword","page","count","limit","offset","word","mid","sid","pic_id","lyric_id","target","nocache","s"]);
const TYPES = new Set(["search","url","song","lyric","pic","playlist","toplist","artist","album","detail","mv","lrc"]);
const SOURCES = new Set(["netease","kuwo","bilibili"]);
const MAX_API_BYTES = 2 * 1024 * 1024;
const KUWO_DOMAIN = "kuwo.cn";

function safeHeaders(source) {
  const headers = new Headers();
  if (source) for (const [key, value] of source.entries()) if (SAFE_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
  return headers;
}
function normalizeKuwoUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password ||
      !(host === KUWO_DOMAIN || host.endsWith("." + KUWO_DOMAIN))) return null;
  url.protocol = "http:";
  return url;
}
function validateParameters(url) {
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (!QUERY_KEYS.has(key) || seen.has(key) || value.length > 2048) return "invalid";
    seen.add(key);
  }
  const target = url.searchParams.get("target");
  if (target) return normalizeKuwoUrl(target) ? "audio" : "invalid";
  const type = url.searchParams.get("types");
  if (!type || !TYPES.has(type)) return "invalid";
  const source = url.searchParams.get("source");
  if (source && !SOURCES.has(source.toLowerCase())) return "invalid";
  if (url.searchParams.has("nocache") && !["true","false"].includes(url.searchParams.get("nocache"))) return "invalid";
  return "api";
}
async function fetchKuwoAudio(rawTarget, request) {
  let current = normalizeKuwoUrl(rawTarget);
  if (!current) return new Response("Invalid target", { status: 400 });
  const requestHeaders = new Headers({
    "User-Agent": request.headers.get("User-Agent") || "Solara/2",
    "Referer": "https://www.kuwo.cn/",
  });
  const range = request.headers.get("Range");
  if (range) requestHeaders.set("Range", range);
  for (let hop = 0; hop <= 3; hop++) {
    const upstream = await fetch(current.toString(), {
      method: request.method, headers: requestHeaders, redirect: "manual", signal: request.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      await upstream.body?.cancel();
      if (hop === 3 || !location) return new Response("Redirect rejected", { status: 502 });
      const next = normalizeKuwoUrl(new URL(location, current).toString());
      if (!next) return new Response("Redirect rejected", { status: 502 });
      current = next;
      continue;
    }
    const headers = safeHeaders(upstream.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  return new Response("Redirect rejected", { status: 502 });
}
function validateApiBase(value) {
  let url;
  try { url = new URL(value || DEFAULT_API_BASE_URL); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  return url;
}
async function fetchApi(url, request, baseUrl) {
  const apiUrl = new URL(baseUrl.toString());
  for (const [key, value] of url.searchParams) {
    if (!["target","callback","s","nocache"].includes(key)) apiUrl.searchParams.set(key, value);
  }
  if (!apiUrl.searchParams.has("types")) return new Response("Missing types", { status: 400 });
  for (let hop = 0; hop <= 3; hop++) {
    const upstream = await fetch(apiUrl.toString(), {
      method: request.method,
      headers: { "User-Agent": "Meting/1.5.0", "Accept": "application/json" },
      redirect: "manual",
      signal: request.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      await upstream.body?.cancel();
      if (hop === 3 || !location) return new Response("Upstream redirect rejected", { status: 502 });
      const next = new URL(location, apiUrl);
      if (next.protocol !== "https:" || next.hostname !== baseUrl.hostname || next.port !== baseUrl.port) {
        return new Response("Upstream redirect rejected", { status: 502 });
      }
      apiUrl.href = next.toString();
      continue;
    }
    return upstream;
  }
  return new Response("Upstream redirect rejected", { status: 502 });
}
async function readLimitedText(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_API_BYTES) { await response.body?.cancel(); throw new Error("UPSTREAM_TOO_LARGE"); }
  if (!response.body || response.status === 204 || response.status === 304) return "";
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_BYTES) { await reader.cancel(); throw new Error("UPSTREAM_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function proxyApiRequest(url, request, env) {
  const baseUrl = validateApiBase(env?.API_BASE_URL);
  if (!baseUrl) return new Response("Invalid music API configuration", { status: 503 });
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s"); cacheUrl.searchParams.delete("nocache"); cacheUrl.searchParams.delete("target");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const bypass = url.searchParams.get("nocache") === "true";
  const canCache = request.method === "GET" && !bypass;
  if (canCache) {
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const headers = safeHeaders(cached.headers);
        headers.set("X-Cache-Status", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }
    } catch {}
  }
  let upstream, responseText;
  try {
    upstream = await fetchApi(url, request, baseUrl);
    responseText = await readLimitedText(upstream);
  } catch (error) {
    if (error.message === "UPSTREAM_TOO_LARGE") return new Response("Music response too large", { status: 502 });
    return new Response("Music upstream unavailable", { status: 502 });
  }
  const headers = safeHeaders(upstream.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  const isEmptySearch = url.searchParams.get("types") === "search" && responseText.trim() === "[]";
  const shouldCache = canCache && upstream.status === 200 && !isEmptySearch &&
    !responseText.includes('"error"') && !responseText.includes('"status":0');
  headers.set("X-Cache-Status", "MISS");
  headers.set("Cache-Control", shouldCache ? "public, s-maxage=300, max-age=300" : "no-store, no-cache, must-revalidate");
  const response = new Response(responseText, { status: upstream.status, statusText: upstream.statusText, headers });
  if (shouldCache) {
    try { await caches.default.put(cacheKey, response.clone()); } catch {}
  }
  return response;
}
export async function onRequest({ request, env }: { request: Request; env: Record<string, string>; }): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  const kind = validateParameters(url);
  if (kind === "invalid") return new Response("Invalid music request", { status: 400 });
  if (kind === "audio") return fetchKuwoAudio(url.searchParams.get("target") || "", request);
  return proxyApiRequest(url, request, env);
}
