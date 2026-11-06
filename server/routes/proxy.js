'use strict';

const { Router } = require('express');
const { Readable } = require('node:stream');
const { rateLimit } = require('../security');
const { HttpError } = require('../http-error');

const ALLOWED_QUERY = new Set(['types','source','id','name','artist','album','br','format','keyword','page','count','limit','offset','word','mid','sid','pic_id','lyric_id','target','nocache','s']);
const ALLOWED_TYPES = new Set(['search','url','song','lyric','pic','playlist','toplist','artist','album','detail','mv','lrc']);
const SOURCES = new Set(['netease','kuwo','bilibili']);
const activeAudio = new Map();

function validateQuery(req) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (!ALLOWED_QUERY.has(key) || Array.isArray(value) || typeof value !== 'string' || value.length > 2048) throw new HttpError(400, 'PROXY_QUERY_INVALID', '音乐请求参数无效');
    params.set(key, value);
  }
  if (params.has('source') && !SOURCES.has(params.get('source').toLowerCase())) throw new HttpError(400, 'PROXY_SOURCE_INVALID', '音乐来源不受支持');
  if (params.has('target')) {
    let target;
    try { target = new URL(params.get('target')); } catch { throw new HttpError(400, 'PROXY_TARGET_INVALID', '音频地址无效'); }
    const host = target.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !(host === 'kuwo.cn' || host.endsWith('.kuwo.cn'))) {
      throw new HttpError(400, 'PROXY_TARGET_REJECTED', '音频目标不受支持');
    }
  } else {
    const type = params.get('types');
    if (!type || !ALLOWED_TYPES.has(type)) throw new HttpError(400, 'PROXY_TYPE_INVALID', '音乐请求类型不受支持');
  }
  return params;
}

function createProxyRouter() {
  const router = Router();
  router.all('/', async (req, res, next) => {
    let params;
    try { params = validateQuery(req); } catch (error) { return next(error); }
    const isAudio = params.has('target');
    const userId = req.user.id;
    if (!isAudio && params.get('types') === 'search') {
      const limit = rateLimit('music-search:' + userId, Number(process.env.SEARCH_PER_MINUTE || 30), 60000);
      if (!limit.allowed) { res.set('Retry-After', String(limit.retryAfter)); return next(new HttpError(429, 'RATE_LIMITED', '搜索请求过于频繁')); }
    }
    const count = isAudio ? (activeAudio.get(userId) || 0) : 0;
    if (isAudio && count >= Number(process.env.AUDIO_STREAMS_PER_USER || 2)) return next(new HttpError(429, 'AUDIO_STREAM_LIMIT', '当前设备的音频连接已达到上限'));
    if (isAudio) activeAudio.set(userId, count + 1);

    const base = process.env.INTERNAL_PROXY_URL || process.env.WRANGLER_API_URL;
    const internalToken = process.env.INTERNAL_PROXY_TOKEN;
    if (!base || !internalToken) {
      if (isAudio) activeAudio.set(userId, Math.max(0, (activeAudio.get(userId) || 1) - 1));
      return next(new HttpError(503, 'MUSIC_PROXY_UNAVAILABLE', '音乐代理尚未就绪'));
    }
    let target;
    try {
      target = new URL('/proxy', base);
      if (target.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(target.hostname)) throw new Error('not-local');
    } catch {
      if (isAudio) activeAudio.set(userId, Math.max(0, (activeAudio.get(userId) || 1) - 1));
      return next(new HttpError(503, 'MUSIC_PROXY_UNAVAILABLE', '内部音乐代理地址无效'));
    }
    target.search = params.toString();

    const controller = new AbortController();
    const closeHandler = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', closeHandler);
    try {
      const upstream = await fetch(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: {
          Authorization: 'Bearer ' + internalToken,
          'User-Agent': req.get('User-Agent') || 'Solara/2',
          ...(req.get('Range') ? { Range: req.get('Range') } : {}),
          Accept: isAudio ? '*/*' : 'application/json',
        },
        redirect: 'manual',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(isAudio ? 30000 : 10000)]),
      });
      res.status(upstream.status);
      for (const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (isAudio) res.setHeader('Cache-Control', 'private, no-store');
      else res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=300');
      if (!upstream.body) return res.end();
      if (isAudio) {
        Readable.fromWeb(upstream.body).pipe(res);
        await new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); });
      } else {
        const reader = upstream.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new HttpError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '音乐服务响应过大');
          }
          chunks.push(Buffer.from(value));
        }
        res.end(Buffer.concat(chunks));
      }
    } catch (error) {
      if (!res.headersSent) next(error instanceof HttpError ? error : new HttpError(502, 'MUSIC_PROXY_FAILED', '音乐服务暂时不可用'));
      else if (!res.writableEnded) res.destroy();
    } finally {
      res.removeListener('close', closeHandler);
      if (isAudio) {
        const remaining = (activeAudio.get(userId) || 1) - 1;
        if (remaining > 0) activeAudio.set(userId, remaining); else activeAudio.delete(userId);
      }
    }
  });
  return router;
}
module.exports = createProxyRouter;
