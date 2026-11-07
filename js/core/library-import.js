'use strict';

import { apiRequest } from './auth.js';
import { sanitizeImportedSong } from '../features/playlist.js';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

function readItems(payload, target) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = target === 'favorites'
    ? [payload.favorites, payload.items, payload.songs, payload.data]
    : [payload.queue, payload.items, payload.songs, payload.playlist, payload.tracks, payload.data];
  return candidates.find(Array.isArray) || [];
}

export async function importLibraryFile(file, target = 'queue') {
  if (!file) return null;
  if (!['queue', 'favorites'].includes(target)) throw new Error('导入目标无效');
  if (file.size > MAX_IMPORT_BYTES) throw new Error('导入文件不能超过 2 MB');

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error('导入失败：文件不是有效的 JSON');
  }
  const rawItems = readItems(payload, target);
  if (!rawItems.length) throw new Error('文件中没有可导入的歌曲');
  const songs = rawItems.map(sanitizeImportedSong).filter(Boolean);
  if (!songs.length) throw new Error('文件中的歌曲缺少有效的标题或歌曲信息');

  const result = await apiRequest('/api/me/import', {
    method: 'POST',
    body: { sourceType: 'json-v2', [target]: songs },
  });
  window.location.reload();
  return result;
}
