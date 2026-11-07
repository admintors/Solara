/**
 * 调色板接口 —— 移植自 functions/palette.ts
 * GET /palette?image=<url>
 *
 * 主要差异：
 *   - 去掉 cf: { image: { ... } } Cloudflare 专有 fetch 选项（直接 fetch 原图）
 *   - 用本地内存缓存替代 caches.default（缓存 1 小时）
 *   - 颜色分析算法代码原样移植，无任何改动
 *   - 注意：PNG 图片会返回 415（unsupported），前端已有 Canvas 降级处理
 */

const { Router } = require('express');
const path = require('path');
const { pathToFileURL } = require('node:url');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const cache = require('../cache');

// jpeg-decoder.js 是 ESM 模块（export default），Node.js 需用动态 import()
// 用一个 Promise 缓存，确保只 import 一次
const DECODER_PATH = path.join(__dirname, '../../functions/lib/vendor/jpeg-decoder.js').replace(/\\/g, '/');
const _decoderPromise = import(pathToFileURL(DECODER_PATH).href).then(m => m.default || m.decode);

async function getDecoder() {
  return _decoderPromise;
}

// ─── 常量（与 palette.ts 一致）─────────────────────────────────────────────────
const MAX_DIMENSION = 96;
const TARGET_SAMPLE_COUNT = 2400;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const MAX_IMAGE_PIXELS = 20_000_000;
const ALLOWED_IMAGE_DOMAINS = ['music.126.net', 'kuwo.cn', 'hdslb.com', 'gtimg.cn', 'gtimg.com'];

function isAllowedImageTarget(input) {
  let url;
  try { url = input instanceof URL ? new URL(input.toString()) : new URL(String(input)); }
  catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  return ALLOWED_IMAGE_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const value = parts.reduce((n, octet) => n * 256 + octet, 0);
    const inRange = (base, bits) => Math.floor(value / (2 ** (32 - bits))) === Math.floor(base / (2 ** (32 - bits)));
    const blocked = [[0,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc0586300,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]];
    return !blocked.some(([base,bits]) => inRange(base,bits));
  }
  if (family !== 6 || address.includes('%')) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return false;
  const halves = lower.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - left.length - right.length;
  if (zeros < 0 || (halves.length === 1 && zeros !== 0)) return false;
  const groups = [...left, ...Array(zeros).fill('0'), ...right].map(value => parseInt(value || '0', 16));
  if (groups.length !== 8 || groups.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) return false;
  const first = groups[0];
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002 || (first === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8))) return false;
  return true;
}

async function resolvePinnedAddress(hostname, timeoutMs) {
  let timer;
  const rows = await Promise.race([
    dns.lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IMAGE_TIMEOUT')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) throw new Error('IMAGE_TARGET_REJECTED');
  return rows[0];
}

function requestImageOnce(url, pinned, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      callback(value);
    };
    const request = https.request({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port || 443,
      method: 'GET',
      path: url.pathname + url.search,
      servername: url.hostname,
      agent: false,
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'Solara/2' },
    }, response => {
      const status = response.statusCode || 502;
      const location = response.headers.location;
      if (status >= 300 && status < 400) {
        response.resume();
        finish(resolve, { status, location, headers: response.headers, buffer: null });
        return;
      }
      const declaredSize = Number(response.headers['content-length'] || 0);
      if (declaredSize > MAX_IMAGE_BYTES) {
        response.destroy();
        finish(reject, new Error('IMAGE_TOO_LARGE'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          response.destroy(new Error('IMAGE_TOO_LARGE'));
          request.destroy(new Error('IMAGE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, { status, headers: response.headers, buffer: Buffer.concat(chunks, size) }));
      response.on('error', error => finish(reject, error));
    });
    const absoluteTimer = setTimeout(() => request.destroy(new Error('IMAGE_TIMEOUT')), timeoutMs);
    request.on('error', error => finish(reject, error));
    request.end();
  });
}

async function fetchSafeImage(input) {
  const deadline = Date.now() + 5000;
  let current = input instanceof URL ? new URL(input.toString()) : new URL(String(input));
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    if (!isAllowedImageTarget(current)) throw new Error('IMAGE_TARGET_REJECTED');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('IMAGE_TIMEOUT');
    const pinned = await resolvePinnedAddress(current.hostname, remaining);
    const remainingAfterDns = deadline - Date.now();
    if (remainingAfterDns <= 0) throw new Error('IMAGE_TIMEOUT');
    const response = await requestImageOnce(current, pinned, remainingAfterDns);
    if (response.status >= 300 && response.status < 400) {
      if (hop === MAX_IMAGE_REDIRECTS || !response.location) throw new Error('IMAGE_REDIRECT_REJECTED');
      current = new URL(response.location, current);
      continue;
    }
    return { ...response, url: current };
  }
  throw new Error('IMAGE_REDIRECT_REJECTED');
}

function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (startOfFrame.has(marker) && length >= 7) return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    offset += length;
  }
  return null;
}

function enforceDecodeLimit(buffer, contentType) {
  if (!contentType.toLowerCase().startsWith('image/jpeg')) return;
  const dimensions = jpegDimensions(buffer);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 ||
      dimensions.width > 10000 || dimensions.height > 10000 ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error('IMAGE_DIMENSION_LIMIT');
}


// ─── 工具函数（直接从 palette.ts 移植）────────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function componentToHex(value) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function rgbToHex({ r, g, b }) {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function rgbToHsl(r, g, b) {
  const rN = clamp(r / 255, 0, 1);
  const gN = clamp(g / 255, 0, 1);
  const bN = clamp(b / 255, 0, 1);
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rN) h = ((gN - bN) / delta) % 6;
    else if (max === gN) h = (bN - rN) / delta + 2;
    else h = (rN - gN) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  const sat = clamp(s, 0, 1);
  const lit = clamp(l, 0, 1);
  const nh = (((h % 360) + 360) % 360) / 360;
  if (sat === 0) { const v = lit * 255; return { r: v, g: v, b: v }; }
  const q = lit < 0.5 ? lit * (1 + sat) : lit + sat - lit * sat;
  const p = 2 * lit - q;
  return {
    r: hueToRgb(p, q, nh + 1 / 3) * 255,
    g: hueToRgb(p, q, nh) * 255,
    b: hueToRgb(p, q, nh - 1 / 3) * 255,
  };
}

function hslToHex(color) {
  return rgbToHex(hslToRgb(color.h, color.s, color.l));
}

function relativeLuminance(r, g, b) {
  const normalize = v => {
    const c = clamp(v / 255, 0, 1);
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
}

function pickContrastColor(color) {
  return relativeLuminance(color.r, color.g, color.b) > 0.45 ? '#1f2937' : '#f8fafc';
}

function adjustSaturation(base, factor, offset = 0) {
  return clamp(base * factor + offset, 0, 1);
}

function adjustLightness(base, offset, factor = 1) {
  return clamp(base * factor + offset, 0, 1);
}

function analyzeImageColors(image) {
  const { data } = image;
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / TARGET_SAMPLE_COUNT));
  let totalR = 0, totalG = 0, totalB = 0, validCount = 0;
  let desaturatedCount = 0;

  const NUM_BINS = 24;
  const binWeights = new Float32Array(NUM_BINS);
  const binR = new Float64Array(NUM_BINS);
  const binG = new Float64Array(NUM_BINS);
  const binB = new Float64Array(NUM_BINS);

  for (let i = 0; i < data.length; i += step * 4) {
    if (data[i + 3] < 48) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    totalR += r; totalG += g; totalB += b; validCount++;

    const hsl = rgbToHsl(r, g, b);
    if (hsl.s < 0.15) {
      desaturatedCount++;
    }

    if (hsl.l < 0.07 || hsl.l > 0.94) continue;
    if (hsl.s < 0.12) continue;

    const binIndex = Math.min(NUM_BINS - 1, Math.max(0, Math.floor((hsl.h % 360) / (360 / NUM_BINS))));
    const lightnessBalance = 1 - Math.abs(hsl.l - 0.5) * 1.4;
    const weight = Math.max(0.1, lightnessBalance) * (hsl.s * 0.6 + 0.4);

    binWeights[binIndex] += weight;
    binR[binIndex] += r * weight;
    binG[binIndex] += g * weight;
    binB[binIndex] += b * weight;
  }

  if (validCount === 0) throw new Error('No opaque pixels available for analysis');
  const average = rgbToHsl(totalR / validCount, totalG / validCount, totalB / validCount);

  // 黑白艺术封面判定
  const desatRatio = desaturatedCount / validCount;
  if (desatRatio >= 0.72) {
    return {
      isMonochrome: true,
      average,
      accent: { h: 215, s: 0.04, l: 0.46 },
    };
  }

  let bestBin = -1;
  let maxWeight = 0;
  for (let b = 0; b < NUM_BINS; b++) {
    if (binWeights[b] > maxWeight) {
      maxWeight = binWeights[b];
      bestBin = b;
    }
  }

  if (bestBin === -1 || maxWeight <= 0) {
    return {
      isMonochrome: desatRatio >= 0.5,
      average,
      accent: average,
    };
  }

  const dominantHsl = rgbToHsl(
    binR[bestBin] / maxWeight,
    binG[bestBin] / maxWeight,
    binB[bestBin] / maxWeight
  );

  return {
    isMonochrome: false,
    average,
    accent: dominantHsl,
  };
}

function buildGradientStops(accent, isMonochrome = false) {
  if (isMonochrome) {
    const lc = ["#dde1e7", "#d3d8df", "#c6cdd6"];
    const dc = ["#181a20", "#121418", "#0d0f12"];
    return {
      light: { colors: lc, gradient: `linear-gradient(140deg, ${lc[0]} 0%, ${lc[1]} 45%, ${lc[2]} 100%)` },
      dark:  { colors: dc, gradient: `linear-gradient(135deg, ${dc[0]} 0%, ${dc[1]} 55%, ${dc[2]} 100%)` },
    };
  }

  const isRedFamily = (accent.h >= 335 || accent.h <= 24);
  let lc;

  if (isRedFamily) {
    // 红色防粉红机制：明度锁定在 0.65~0.72，色相微调向暖陶土红，绝不生成粉红
    const warmH = (accent.h + 14) % 360;
    const redS = clamp(accent.s * 0.28 + 0.06, 0.16, 0.28);
    lc = [
      hslToHex({ h: warmH, s: redS, l: 0.70 }),
      hslToHex({ h: (warmH + 10) % 360, s: Math.max(0.12, redS - 0.03), l: 0.73 }),
      hslToHex({ h: warmH, s: Math.max(0.10, redS - 0.05), l: 0.76 }),
    ];
  } else {
    // 常规彩色：浅色模式明度控制在 0.72~0.80 舒适区间，杜绝惨白死光
    const lightS = clamp(accent.s * 0.26 + 0.06, 0.14, 0.30);
    lc = [
      hslToHex({ h: accent.h, s: lightS, l: clamp(accent.l * 0.10 + 0.72, 0.72, 0.79) }),
      hslToHex({ h: (accent.h + 16) % 360, s: Math.max(0.11, lightS - 0.03), l: clamp(accent.l * 0.08 + 0.75, 0.74, 0.81) }),
      hslToHex({ h: accent.h, s: Math.max(0.09, lightS - 0.05), l: clamp(accent.l * 0.06 + 0.77, 0.76, 0.83) }),
    ];
  }

  // 暗色模式：午夜深邃光晕，严格抑制饱和度上限 (0.14~0.28)，彻底消除夜间刺眼荧光
  const darkS = clamp(accent.s * 0.34, 0.14, 0.28);
  const dc = [
    hslToHex({ h: accent.h, s: darkS, l: clamp(accent.l * 0.08 + 0.15, 0.13, 0.22) }),
    hslToHex({ h: (accent.h + 12) % 360, s: Math.max(0.10, darkS - 0.04), l: clamp(accent.l * 0.06 + 0.12, 0.10, 0.18) }),
    hslToHex({ h: accent.h, s: Math.max(0.08, darkS - 0.06), l: clamp(accent.l * 0.05 + 0.09, 0.08, 0.14) }),
  ];

  return {
    light: { colors: lc, gradient: `linear-gradient(140deg, ${lc[0]} 0%, ${lc[1]} 45%, ${lc[2]} 100%)` },
    dark:  { colors: dc, gradient: `linear-gradient(135deg, ${dc[0]} 0%, ${dc[1]} 55%, ${dc[2]} 100%)` },
  };
}

function buildThemeTokens(accent) {
  return {
    light: {
      primaryColor:     hslToHex({ h: accent.h, s: clamp(accent.s * 0.40 + 0.08, 0.18, 0.45), l: clamp(accent.l * 0.16 + 0.34, 0.30, 0.42) }),
      primaryColorDark: hslToHex({ h: accent.h, s: clamp(accent.s * 0.45 + 0.05, 0.20, 0.50), l: clamp(accent.l * 0.12 + 0.24, 0.22, 0.34) }),
    },
    dark: {
      primaryColor:     hslToHex({ h: accent.h, s: clamp(accent.s * 0.36 + 0.06, 0.18, 0.38), l: clamp(accent.l * 0.12 + 0.36, 0.32, 0.44) }),
      primaryColorDark: hslToHex({ h: accent.h, s: clamp(accent.s * 0.40 + 0.04, 0.20, 0.42), l: clamp(accent.l * 0.08 + 0.26, 0.22, 0.32) }),
    },
  };
}

function resizeImage(image) {
  const maxSide = Math.max(image.width, image.height);
  if (maxSide <= MAX_DIMENSION) return image;
  const scale = MAX_DIMENSION / maxSide;
  const width  = Math.max(1, Math.round(image.width  * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const resized = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(image.width - 1, Math.floor(x / scale));
      const si = (srcY * image.width + srcX) * 4;
      const di = (y * width + x) * 4;
      resized[di]     = image.data[si];
      resized[di + 1] = image.data[si + 1];
      resized[di + 2] = image.data[si + 2];
      resized[di + 3] = image.data[si + 3];
    }
  }
  return { width, height, data: resized };
}

async function decodeImage(arrayBuffer, contentType) {
  const subtype = (contentType.split('/')[1] || '').split(';')[0].toLowerCase();
  const supported = ['jpeg', 'jpg', 'pjpeg'];
  if (!supported.includes(subtype)) {
    const err = new Error(`Unsupported image format: ${subtype}`);
    err.name = 'UnsupportedImageFormatError';
    throw err;
  }
  const decodeJpeg = await getDecoder();
  const bytes = new Uint8Array(arrayBuffer);
  const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
  return resizeImage({
    width: decoded.width,
    height: decoded.height,
    data: new Uint8ClampedArray(decoded.data),
  });
}

async function buildPalette(arrayBuffer, contentType) {
  const imageData = await decodeImage(arrayBuffer, contentType);
  const analyzed  = analyzeImageColors(imageData);
  const gradients = buildGradientStops(analyzed.accent, analyzed.isMonochrome);
  const tokens    = buildThemeTokens(analyzed.accent);
  const accentRgb = hslToRgb(analyzed.accent.h, analyzed.accent.s, analyzed.accent.l);
  return {
    source: '',
    baseColor:     hslToHex(analyzed.accent),
    averageColor:  hslToHex(analyzed.average),
    accentColor:   hslToHex(analyzed.accent),
    contrastColor: pickContrastColor(accentRgb),
    gradients: { light: gradients.light, dark: gradients.dark },
    tokens,
  };
}

// ─── Express 路由 ──────────────────────────────────────────────────────────────

function createPaletteRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    const imageParam = req.query.image || req.query.url;
    if (typeof imageParam !== 'string' || imageParam.length > 4096) return res.status(400).json({ error: 'Invalid image URL' });
    let target;
    try { target = new URL(imageParam); } catch { return res.status(400).json({ error: 'Invalid image URL' }); }
    if (!isAllowedImageTarget(target)) return res.status(400).json({ error: 'Image source is not allowed' });

    const cacheKey = 'palette:v4:' + target.toString();
    const cached = cache.get(cacheKey);
    if (cached) return res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Cache-Status': 'HIT',
    }).send(cached.body);

    let upstream;
    try { upstream = await fetchSafeImage(target); }
    catch (error) {
      if (error.message === 'IMAGE_TARGET_REJECTED' || error.message === 'IMAGE_REDIRECT_REJECTED') return res.status(400).json({ error: 'Image source is not allowed' });
      if (error.message === 'IMAGE_TOO_LARGE' || error.message === 'IMAGE_DIMENSION_LIMIT') return res.status(413).json({ error: 'Image exceeds processing limits' });
      return res.status(502).json({ error: 'Image source is unavailable' });
    }
    if (upstream.status < 200 || upstream.status >= 300) return res.status(502).json({ error: 'Image source is unavailable' });
    const contentType = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return res.status(415).json({ error: 'Unsupported image format' });
    try { enforceDecodeLimit(upstream.buffer, contentType); }
    catch { return res.status(413).json({ error: 'Image exceeds processing limits' }); }

    try {
      const palette = await buildPalette(upstream.buffer, contentType);
      palette.source = upstream.url.toString();
      const json = JSON.stringify(palette);
      cache.set(cacheKey, { body: json, contentType: 'application/json' }, 3600);
      return res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Cache-Status': 'MISS',
      }).send(json);
    } catch (error) {
      if (error.name === 'UnsupportedImageFormatError') return res.status(415).json({ error: error.message });
      return res.status(415).json({ error: 'Unsupported image format' });
    }
  });
  return router;
}
module.exports = Object.assign(createPaletteRouter, { isAllowedImageTarget, isPublicAddress, fetchSafeImage, jpegDimensions, enforceDecodeLimit });