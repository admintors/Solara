'use strict';

const { createApp } = require('./app');
const { getDb, closeDb } = require('./db');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const INTERNAL_PROXY_URL = process.env.INTERNAL_PROXY_URL || process.env.WRANGLER_API_URL || '';
let server;
let probeTimer;

async function checkInternalProxy() {
  if (!INTERNAL_PROXY_URL) { globalThis.__solaraProxyReady = false; return false; }
  try {
    const health = new URL('/healthz', INTERNAL_PROXY_URL);
    const response = await fetch(health, {
      headers: { Authorization: 'Bearer ' + (process.env.INTERNAL_PROXY_TOKEN || '') },
      signal: AbortSignal.timeout(1500),
    });
    globalThis.__solaraProxyReady = response.ok;
    return response.ok;
  } catch {
    globalThis.__solaraProxyReady = false;
    return false;
  }
}

function start() {
  const database = getDb();
  const app = createApp({ database, proxyReady: () => !INTERNAL_PROXY_URL || globalThis.__solaraProxyReady === true });
  checkInternalProxy();
  probeTimer = setInterval(checkInternalProxy, 5000);
  if (probeTimer.unref) probeTimer.unref();
  server = app.listen(PORT, HOST, () => console.log('[server] listening on ' + HOST + ':' + PORT + ' (' + (process.env.APP_ENV || 'production') + ')'));
  const shutdown = signal => {
    console.log('[server] received ' + signal + ', shutting down');
    clearInterval(probeTimer);
    if (!server) return process.exit(0);
    server.close(() => {
      try { closeDb(); } finally { process.exit(0); }
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}
if (require.main === module) {
  try { start(); } catch (error) { console.error('[server] startup failed:', error.message); process.exitCode = 1; }
}
module.exports = { start, checkInternalProxy };
