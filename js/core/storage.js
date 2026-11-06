'use strict';

import { apiRequest, getSession } from './auth.js';

let enabled = false;
let userId = null;
let prefix = 'solara:v2:anonymous:';
let baseline = { queueId: null, queueVersion: 0, queueItems: [], favorites: [], favoritesVersion: 1, settings: {}, settingsVersion: 1, playbackVersion: 0, customPlaylists: [] };
let writeChain = Promise.resolve();
let playbackTimer = null;
let lastPlaybackWrite = 0;
let syncStatus = { state: 'synced', message: '已同步' };
const REMOTE_KEYS = new Set(['playlistSongs', 'favoriteSongs', 'radarSettings', 'playbackQuality', 'searchSource', 'currentSong', 'currentPlaybackTime', 'currentTrackIndex', 'currentList', 'currentPlaylist', 'playMode']);
const DEFAULT_SOURCE = 'netease';

function identity(song) {
  if (!song || typeof song !== 'object') return '';
  const id = song.id ?? song.trackId ?? song.track_id;
  return id == null ? '' : String(song.source || DEFAULT_SOURCE) + ':' + String(id);
}
function parse(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
function setStatus(state, message) {
  syncStatus = { state, message };
  try { window.dispatchEvent(new CustomEvent('solara:sync-status', { detail: syncStatus })); } catch {}
}
function storageKey(key) { return prefix + key; }
function writeLocal(key, value) {
  try { localStorage.setItem(storageKey(key), String(value)); } catch (error) { console.warn('本地缓存不可用', error); }
}
function readLocal(key) {
  try { return localStorage.getItem(storageKey(key)); } catch { return null; }
}
function updateQueue(payload) {
  if (!payload) return;
  baseline.queueId = payload.id || baseline.queueId;
  baseline.queueVersion = Number(payload.version || baseline.queueVersion || 0);
  baseline.queueItems = Array.isArray(payload.items) ? payload.items : [];
}
function updateFavorites(items, version) {
  baseline.favorites = Array.isArray(items) ? items : [];
  if (Number.isInteger(Number(version))) baseline.favoritesVersion = Number(version);
}
function updateSettings(settings, version) {
  baseline.settings = settings && typeof settings === 'object' ? settings : {};
  if (Number.isInteger(Number(version))) baseline.settingsVersion = Number(version);
}
function snapshotFromBootstrap(data, allFavorites) {
  const result = { ...data };
  result.favorites = { ...data.favorites, items: allFavorites, complete: true };
  return result;
}
async function loadSnapshot() {
  const data = await apiRequest('/api/me/bootstrap');
  let favorites = Array.isArray(data.favorites?.items) ? [...data.favorites.items] : [];
  let offset = favorites.length;
  while (offset < Number(data.favorites?.count || 0)) {
    const page = await apiRequest('/api/me/favorites?limit=100&offset=' + offset);
    favorites.push(...(page.items || []));
    if (page.nextOffset == null) break;
    offset = page.nextOffset;
  }
  if (data.playback?.state?.context === 'playlist' && data.playback.state.playlistId) {
    const playlist = await apiRequest('/api/me/playlists/' + encodeURIComponent(data.playback.state.playlistId));
    data.playlists = (data.playlists || []).map(item => item.id === playlist.id ? playlist : item);
  }
  return snapshotFromBootstrap(data, favorites);
}
function songsFromItems(items) { return (items || []).map(item => item.song).filter(Boolean); }
function matchingSong(songList, source, trackId) {
  return songList.find(song => String(song.source || DEFAULT_SOURCE) === String(source) && String(song.id) === String(trackId)) || null;
}
function applySnapshot(snapshot) {
  if (!userId) throw new Error('User namespace is not initialized');
  const cachedCurrentSong = parse(readLocal('currentSong'), null);
  const queue = snapshot.queue || { id: null, version: 0, items: [] };
  const queueSongs = songsFromItems(queue.items);
  const favorites = songsFromItems(snapshot.favorites?.items);
  updateQueue(queue);
  updateFavorites(snapshot.favorites?.items, snapshot.favorites?.version);
  updateSettings(snapshot.settings?.settings || {}, snapshot.settings?.version || 1);
  baseline.playbackVersion = Number(snapshot.playback?.version || 0);
  baseline.customPlaylists = snapshot.playlists || [];

  writeLocal('playlistSongs', JSON.stringify(queueSongs));
  writeLocal('favoriteSongs', JSON.stringify(favorites));
  writeLocal('currentTrackIndex', '-1');
  writeLocal('currentFavoriteIndex', '0');
  writeLocal('currentList', 'playlist');
  writeLocal('currentPlaylist', 'playlist');
  writeLocal('playMode', 'list');
  writeLocal('currentPlaybackTime', '0');
  writeLocal('currentSong', '');
  if (snapshot.settings?.settings?.playbackQuality) writeLocal('playbackQuality', snapshot.settings.settings.playbackQuality);
  if (snapshot.settings?.settings?.searchSource) writeLocal('searchSource', snapshot.settings.settings.searchSource);
  if (snapshot.settings?.settings?.radarSettings) writeLocal('radarSettings', JSON.stringify(snapshot.settings.settings.radarSettings));

  const playback = snapshot.playback?.state;
  if (playback && playback.trackId && !playback.cleared) {
    let song = matchingSong(queueSongs, playback.source, playback.trackId) || matchingSong(favorites, playback.source, playback.trackId);
    if (playback.context === 'playlist' && playback.playlistId) {
      const list = baseline.customPlaylists.find(item => item.id === playback.playlistId);
      if (list && Array.isArray(list.items)) song = matchingSong(list.items.map(item => item.song || item), playback.source, playback.trackId) || song;
    }
    const cached = cachedCurrentSong;
    if (!song && cached && identity(cached) === String(playback.source) + ':' + String(playback.trackId)) song = cached;
    if (song) {
      const favoritesContext = playback.context === 'favorites';
      const selected = favoritesContext ? favorites : queueSongs;
      writeLocal('currentList', favoritesContext ? 'favorite' : 'playlist');
      writeLocal('currentTrackIndex', String(selected.findIndex(item => identity(item) === identity(song))));
      writeLocal('currentFavoriteIndex', String(favorites.findIndex(item => identity(item) === identity(song))));
      writeLocal('currentPlaylist', playback.context === 'playlist' ? playback.playlistId : 'playlist');
      writeLocal('playMode', playback.playMode || 'list');
      writeLocal('currentSong', JSON.stringify(song));
      writeLocal('currentPlaybackTime', String(Math.floor(Number(playback.positionMs || 0) / 1000)));
    }
  }
  setStatus('synced', '已同步');
}
export async function initializeUserStorage(context, snapshot) {
  userId = context.user.id;
  prefix = 'solara:v2:' + userId + ':';
  applySnapshot(snapshot);
  enabled = true;
  return snapshot;
}
export async function refreshUserLibrary() {
  if (!userId) throw new Error('请先登录');
  const snapshot = await loadSnapshot();
  applySnapshot(snapshot);
  return snapshot;
}
export async function loadUserLibrary() { return loadSnapshot(); }
export function getLibraryMetadata() {
  return {
    queueId: baseline.queueId,
    queueVersion: baseline.queueVersion,
    favoritesVersion: baseline.favoritesVersion,
    settingsVersion: baseline.settingsVersion,
    playbackVersion: baseline.playbackVersion,
    playlists: baseline.customPlaylists,
  };
}
export function getSyncStatus() { return { ...syncStatus }; }
export function setRemoteSyncEnabled(value) { enabled = Boolean(value); }
export function isRemoteSyncEnabled() { return enabled; }

export function createPersistentStorageClient() {
  return {
    checkAvailability: async () => Boolean(getSession()),
    getItems: async () => null,
    setItems: async () => false,
    removeItems: async () => false,
  };
}
export const persistentStorage = createPersistentStorageClient();
export function shouldSyncStorageKey(key) { return REMOTE_KEYS.has(key); }

function queueWrite(task) {
  const operation = writeChain.then(task);
  writeChain = operation.catch(error => {
    if (error?.name === 'StaleAccountError') return;
    const message = error?.code === 'VERSION_CONFLICT'
      ? '其他设备已更新此列表，请刷新后确认'
      : (error?.message || '同步失败，请检查网络后重试');
    setStatus('unsaved', message);
  });
  return operation;
}

async function syncQueue(serialized) {
  const desired = parse(serialized, []);
  if (!Array.isArray(desired) || !baseline.queueId) return;
  const uniqueDesired = [];
  const desiredSet = new Set();
  for (const song of desired) {
    const key = identity(song);
    if (key && !desiredSet.has(key)) { desiredSet.add(key); uniqueDesired.push(song); }
  }
  const remote = baseline.queueItems;
  const remoteByKey = new Map(remote.map(item => [identity(item.song), item]));
  const desiredByKey = new Map(uniqueDesired.map(song => [identity(song), song]));
  const headers = () => '"v' + baseline.queueVersion + '"';
  for (const item of remote) {
    const key = identity(item.song);
    if (desiredByKey.has(key)) continue;
    const result = await apiRequest('/api/me/playlists/' + encodeURIComponent(baseline.queueId) + '/items/' + encodeURIComponent(item.id), {
      method: 'DELETE', body: {}, ifMatch: headers(),
    });
    updateQueue(result);
  }
  const toAdd = uniqueDesired.filter(song => !remoteByKey.has(identity(song)));
  if (toAdd.length) {
    for (let start = 0; start < toAdd.length; start += 200) {
      const result = await apiRequest('/api/me/playlists/' + encodeURIComponent(baseline.queueId) + '/items/batch', {
        method: 'POST', body: { items: toAdd.slice(start, start + 200) }, ifMatch: headers(),
      });
      updateQueue(result.playlist);
    }
  }
  const itemIdByKey = new Map(baseline.queueItems.map(item => [identity(item.song), item.id]));
  const desiredIds = uniqueDesired.map(song => itemIdByKey.get(identity(song))).filter(Boolean);
  const currentIds = baseline.queueItems.map(item => item.id);
  if (desiredIds.length === currentIds.length && desiredIds.some((id, index) => currentIds[index] !== id)) {
    const result = await apiRequest('/api/me/playlists/' + encodeURIComponent(baseline.queueId) + '/order', {
      method: 'PUT', body: { itemIds: desiredIds }, ifMatch: headers(),
    });
    updateQueue(result);
  }
}

async function syncFavorites(serialized) {
  const desired = parse(serialized, []);
  if (!Array.isArray(desired)) return;
  const desiredByKey = new Map(desired.map(song => [identity(song), song]).filter(([key]) => key));
  const remoteByKey = new Map(baseline.favorites.map(item => [identity(item.song), item]));
  for (const [key, item] of remoteByKey) {
    if (desiredByKey.has(key)) continue;
    const result = await apiRequest('/api/me/favorites/' + encodeURIComponent(item.source) + '/' + encodeURIComponent(item.trackId), { method: 'DELETE', body: {} });
    baseline.favoritesVersion = Number(result.version || baseline.favoritesVersion);
    baseline.favorites = baseline.favorites.filter(entry => identity(entry.song) !== key);
  }
  const additions = [...desiredByKey].filter(([key]) => !remoteByKey.has(key));
  for (let start = 0; start < additions.length; start += 200) {
    const batch = additions.slice(start, start + 200);
    const result = await apiRequest('/api/me/favorites/batch', {
      method: 'POST', body: { items: batch.map(([, song]) => song) },
    });
    baseline.favoritesVersion = Number(result.version || baseline.favoritesVersion);
    const known = new Set(baseline.favorites.map(item => identity(item.song)));
    for (const [key, song] of batch) {
      if (known.has(key)) continue;
      baseline.favorites.push({
        source: String(song.source || DEFAULT_SOURCE),
        trackId: String(song.id ?? song.trackId ?? ''),
        song,
      });
      known.add(key);
    }
  }
}

async function syncSettings(key) {
  const field = key === 'radarSettings' ? 'radarSettings' : key;
  let value = readLocal(key);
  if (field === 'radarSettings') value = parse(value, null);
  else if (value == null) return;
  if (JSON.stringify(baseline.settings[field]) === JSON.stringify(value)) return;
  const result = await apiRequest('/api/me/settings', {
    method: 'PATCH',
    body: { settings: { [field]: value } },
    ifMatch: '"v' + baseline.settingsVersion + '"',
  });
  updateSettings(result.settings, result.version);
}

function currentPlayback() {
  const song = parse(readLocal('currentSong'), null);
  if (!song || !identity(song)) return null;
  const contextName = readLocal('currentPlaylist');
  let context = 'queue', playlistId = null;
  if (readLocal('currentList') === 'favorite') context = 'favorites';
  else if (contextName && contextName !== 'playlist' && baseline.customPlaylists.some(item => item.id === contextName)) {
    context = 'playlist'; playlistId = contextName;
  } else if (['search', 'online'].includes(contextName)) context = 'transient';
  return {
    context, ...(playlistId ? { playlistId } : {}),
    source: String(song.source || DEFAULT_SOURCE),
    trackId: String(song.id),
    positionMs: Math.max(0, Math.floor(Number(readLocal('currentPlaybackTime') || 0) * 1000)),
    playMode: ['list','single','random'].includes(readLocal('playMode')) ? readLocal('playMode') : 'list',
  };
}
async function savePlayback() {
  playbackTimer = null;
  const elapsed = Date.now() - lastPlaybackWrite;
  if (elapsed < 15000) {
    playbackTimer = setTimeout(savePlayback, 15000 - elapsed);
    return;
  }
  const state = currentPlayback();
  const ifMatch = '"v' + baseline.playbackVersion + '"';
  if (state) {
    const result = await apiRequest('/api/me/playback', { method: 'PUT', body: state, ifMatch });
    baseline.playbackVersion = Number(result.version || baseline.playbackVersion + 1);
  } else {
    const result = await apiRequest('/api/me/playback', { method: 'DELETE', body: {}, ifMatch });
    baseline.playbackVersion = Number(result.version || baseline.playbackVersion + 1);
  }
  lastPlaybackWrite = Date.now();
}
function schedulePlayback(immediate = false) {
  if (!enabled || playbackTimer) return;
  const wait = immediate ? 0 : Math.max(0, 15000 - (Date.now() - lastPlaybackWrite));
  playbackTimer = setTimeout(() => {
    queueWrite(async () => {
      setStatus('saving', '正在保存播放进度');
      await savePlayback();
      setStatus('synced', '已同步');
    });
  }, wait);
}
function processStorageChange(key, value) {
  if (!enabled || !shouldSyncStorageKey(key)) return;
  queueWrite(async () => {
    setStatus('saving', '正在保存');
    if (key === 'playlistSongs') await syncQueue(value);
    else if (key === 'favoriteSongs') await syncFavorites(value);
    else if (['radarSettings', 'playbackQuality', 'searchSource'].includes(key)) await syncSettings(key);
    else if (['currentSong', 'currentPlaybackTime', 'currentTrackIndex', 'currentList', 'currentPlaylist', 'playMode'].includes(key)) {
      schedulePlayback(key === 'currentSong');
      return;
    }
    setStatus('synced', '已同步');
  }).catch(() => {});
}
export function persistStorageItems(items) {
  if (!items || typeof items !== 'object') return;
  for (const [key, value] of Object.entries(items)) processStorageChange(key, value);
}
export function removePersistentItems(keys = []) {
  if (!Array.isArray(keys)) return;
  for (const key of keys) processStorageChange(key, null);
}
export function syncLocalDataToCloud() {
  throw new Error('请通过单曲操作或明确的导入流程同步数据');
}

export async function clearServerQueue() {
  return queueWrite(async () => {
    const result = await apiRequest('/api/me/playlists/' + encodeURIComponent(baseline.queueId) + '/items/clear', {
      method: 'POST', body: {}, ifMatch: '"v' + baseline.queueVersion + '"',
    });
    updateQueue({ id: baseline.queueId, version: result.version, items: [] });
    return result;
  });
}
export async function clearServerFavorites() {
  return queueWrite(async () => {
    const result = await apiRequest('/api/me/favorites/clear', {
      method: 'POST', body: {}, ifMatch: '"v' + baseline.favoritesVersion + '"',
    });
    updateFavorites([], result.version);
    return result;
  });
}

export function safeGetLocalStorage(key) {
  try { return localStorage.getItem(storageKey(key)); }
  catch (error) { console.warn('读取本地存储失败', error); return null; }
}
export function safeSetLocalStorage(key, value, options = {}) {
  const skipRemote = Boolean(options.skipRemote);
  try { localStorage.setItem(storageKey(key), String(value)); }
  catch (error) { console.warn('写入本地存储失败', error); }
  if (!skipRemote) processStorageChange(key, String(value));
}
export function safeRemoveLocalStorage(key, options = {}) {
  try { localStorage.removeItem(storageKey(key)); } catch {}
  if (!options.skipRemote) processStorageChange(key, null);
}
export function parseJSON(value, fallback) { return parse(value, fallback); }
export function cloneSearchResults(results) {
  if (!Array.isArray(results)) return [];
  try { return JSON.parse(JSON.stringify(results)); }
  catch { return results.map(item => item && typeof item === 'object' ? { ...item } : item); }
}
export function sanitizeStoredSearchState(data, defaultSource = DEFAULT_SOURCE) {
  if (!data || typeof data !== 'object') return null;
  return {
    keyword: typeof data.keyword === 'string' ? data.keyword : '',
    source: typeof data.source === 'string' ? data.source : defaultSource,
    page: Number.isInteger(data.page) && data.page > 0 ? data.page : 1,
    hasMore: typeof data.hasMore === 'boolean' ? data.hasMore : true,
    results: cloneSearchResults(data.results),
  };
}
export function preferHttpsUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol === 'http:' && window.location.protocol === 'https:') parsed.protocol = 'https:';
    return parsed.toString();
  } catch { return window.location.protocol === 'https:' && url.startsWith('http://') ? 'https://' + url.slice(7) : url; }
}
export function toAbsoluteUrl(url) {
  if (!url) return '';
  try { return new URL(url, window.location.href).href; } catch { return url; }
}
export function buildAudioProxyUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol === 'https:') return parsed.toString();
    if (parsed.protocol === 'http:' && /(^|\.)kuwo\.cn$/i.test(parsed.hostname)) return '/proxy?target=' + encodeURIComponent(parsed.toString());
    return parsed.toString();
  } catch { return url; }
}
