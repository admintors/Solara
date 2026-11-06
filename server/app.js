'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { getDb } = require('./db');
const { createSessionMiddleware } = require('./security');
const createAuthRouter = require('./routes/auth');
const createAdminRouter = require('./routes/admin');
const createUserRouter = require('./routes/user');
const createProxyRouter = require('./routes/proxy');
const createPaletteRouter = require('./routes/palette');
const { HttpError, fail } = require('./http-error');

const ROOT_DIR = path.join(__dirname, '..');
function createApp(options = {}) {
  const database = options.database || getDb();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/me/import',
    express.raw({ type: 'application/json', limit: '2mb' }),
    (req, res, next) => {
      try {
        if (!Buffer.isBuffer(req.body)) throw new Error('missing body');
        req.body = JSON.parse(req.body.toString('utf8'));
        next();
      } catch {
        next(new HttpError(400, 'JSON_INVALID', 'JSON 格式无效'));
      }
    }
  );
  app.use(express.json({ limit: '1mb', strict: true }));

  app.get('/healthz', (req, res) => res.json({ data: { ok: true } }));
  app.get('/readyz', (req, res) => {
    try {
      database.prepare('SELECT 1').get();
      const admin = database.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active' LIMIT 1").get();
      if (!admin) return res.status(503).json({ error: { code: 'ADMIN_NOT_INITIALIZED', message: '请先在容器内创建管理员' } });
      if (!process.env.PUBLIC_ORIGIN) return res.status(503).json({ error: { code: 'PUBLIC_ORIGIN_REQUIRED', message: '服务尚未配置公开来源地址' } });
      if (options.proxyReady && !options.proxyReady()) return res.status(503).json({ error: { code: 'PROXY_NOT_READY', message: '内部音乐代理尚未就绪' } });
      return res.json({ data: { ready: true } });
    } catch { return res.status(503).json({ error: { code: 'DATABASE_NOT_READY', message: '数据库尚未就绪' } }); }
  });

  const requireSession = createSessionMiddleware(database);
  app.use('/api/auth', createAuthRouter(database, requireSession));
  app.get('/login', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT_DIR, 'login.html')));
  app.get('/login.html', (req, res) => res.redirect(302, '/login'));
  app.use('/css', express.static(path.join(ROOT_DIR, 'css'), { dotfiles: 'deny', fallthrough: false, index: false }));
  app.use('/js', express.static(path.join(ROOT_DIR, 'js'), { dotfiles: 'deny', fallthrough: false, index: false }));
  for (const name of ['favicon.svg', 'favicon.png', 'manifest.json']) {
    const file = path.join(ROOT_DIR, name);
    if (fs.existsSync(file)) app.get('/' + name, (req, res) => res.sendFile(file));
  }

  app.get('/', (req, res, next) => requireSession(req, res, error => {
    if (error) return next(error);
    res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT_DIR, 'index.html'));
  }));
  app.get('/admin', (req, res, next) => requireSession(req, res, error => {
    if (error) return next(error);
    if (req.user.role !== 'admin') return res.status(404).send('Not Found');
    res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT_DIR, 'admin.html'));
  }));

  app.use('/api/me', requireSession, createUserRouter(database));
  app.use('/api/admin', requireSession, createAdminRouter(database));
  app.use('/proxy', requireSession, createProxyRouter());
  app.use('/palette', requireSession, createPaletteRouter());
  app.use('/api/login', (req, res) => res.status(410).set('Cache-Control', 'no-store').json({ error: { code: 'API_UPGRADE_REQUIRED', message: '请使用用户名与邀请制账号登录' } }));
  app.use('/api/storage', requireSession, (req, res) => res.status(410).set('Cache-Control', 'no-store').json({ error: { code: 'API_UPGRADE_REQUIRED', message: '旧版全局存储接口已停用，请使用新版曲库 API' } }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).set('Cache-Control', 'no-store').json({ error: { code: 'NOT_FOUND', message: '接口不存在', requestId: req.requestId || null } });
    return res.status(404).send('Not Found');
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && 'body' in error) error = new HttpError(400, 'JSON_INVALID', 'JSON 格式无效');
    if (error?.type === 'entity.too.large') error = new HttpError(413, 'REQUEST_TOO_LARGE', '请求内容超过大小限制');
    return fail(res, error, req.requestId);
  });
  return app;
}
module.exports = { createApp, ROOT_DIR };
