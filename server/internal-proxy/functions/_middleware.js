async function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!['/proxy', '/healthz'].includes(url.pathname)) return new Response('Not Found', { status: 404 });
  if (url.pathname === '/healthz' && request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (url.pathname === '/proxy' && !['GET','HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405 });
  const expected = env.INTERNAL_PROXY_TOKEN;
  const authorization = request.headers.get('Authorization') || '';
  if (typeof expected !== 'string' || expected.length < 32 || !await equalSecret(authorization, 'Bearer ' + expected)) {
    return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return context.next();
}
