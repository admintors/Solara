'use strict';

import { apiRequest } from './auth.js';
import { safeGetLocalStorage } from './storage.js';

let dialog, select, title, rows, status, createInput, renameInput, importInput, record;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function action(label, fn, className = '') {
  const node = element('button', 'named-playlist-action ' + className, label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await fn(); }
    catch (error) { status.textContent = error.message || '操作失败'; }
    finally { node.disabled = false; }
  });
  return node;
}
function ifMatch() { return '"v' + record.version + '"'; }

function buildDialog() {
  if (dialog) return;
  dialog = element('dialog', 'named-playlist-dialog');
  const shell = element('div', 'named-playlist-shell');
  const header = element('header', 'named-playlist-header');
  title = element('h2', '', '我的命名歌单');
  header.append(title);
  header.append(action('关闭', () => dialog.close(), 'named-playlist-close'));
  shell.append(header);
  status = element('p', 'named-playlist-status', '选择歌单以查看和管理歌曲');
  status.setAttribute('role', 'status');
  shell.append(status);

  const createRow = element('form', 'named-playlist-create');
  createInput = element('input');
  createInput.type = 'text'; createInput.maxLength = 80; createInput.placeholder = '新歌单名称'; createInput.required = true;
  const createButton = element('button', '', '创建歌单'); createButton.type = 'submit';
  createRow.append(createInput, createButton);
  createRow.addEventListener('submit', async event => {
    event.preventDefault();
    const name = createInput.value.trim();
    if (!name) return;
    createButton.disabled = true;
    try {
      const created = await apiRequest('/api/me/playlists', { method: 'POST', body: { name } });
      createInput.value = '';
      await refreshPlaylists(created.id);
      status.textContent = '歌单已创建';
    } catch (error) { status.textContent = error.message || '创建失败'; }
    finally { createButton.disabled = false; }
  });
  shell.append(createRow);

  const controls = element('div', 'named-playlist-controls');
  select = element('select');
  select.setAttribute('aria-label', '选择命名歌单');
  select.addEventListener('change', () => loadPlaylist(select.value));
  controls.append(select);
  renameInput = element('input');
  renameInput.type = 'text'; renameInput.maxLength = 80; renameInput.placeholder = '重命名';
  controls.append(renameInput);
  controls.append(action('重命名', renamePlaylist));
  controls.append(action('删除歌单', deletePlaylist, 'is-danger'));
  shell.append(controls);

  const songActions = element('div', 'named-playlist-controls');
  songActions.append(action('加入当前队列', addQueue));
  songActions.append(action('导入 JSON', () => importInput.click()));
  songActions.append(action('导出 JSON', exportPlaylist));
  importInput = element('input');
  importInput.type = 'file'; importInput.accept = 'application/json,.json'; importInput.hidden = true;
  importInput.addEventListener('change', importFile);
  songActions.append(importInput);
  shell.append(songActions);
  rows = element('ol', 'named-playlist-items');
  shell.append(rows);
  dialog.append(shell);
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
}

async function refreshPlaylists(selectedId = '') {
  const response = await apiRequest('/api/me/playlists');
  const playlists = (response.playlists || []).filter(item => item.kind === 'custom');
  select.replaceChildren();
  const placeholder = element('option', '', playlists.length ? '选择歌单…' : '暂无命名歌单');
  placeholder.value = '';
  select.append(placeholder);
  for (const item of playlists) {
    const option = element('option', '', item.name);
    option.value = item.id;
    select.append(option);
  }
  const target = selectedId || (playlists[0]?.id || '');
  select.value = target;
  if (target) await loadPlaylist(target);
  else { record = null; rows.replaceChildren(); status.textContent = '创建一个命名歌单来整理歌曲'; }
}
async function loadPlaylist(id) {
  record = null;
  rows.replaceChildren();
  if (!id) return;
  const response = await apiRequest('/api/me/playlists/' + encodeURIComponent(id));
  record = response;
  title.textContent = response.name + ' · ' + response.items.length + ' 首';
  renameInput.value = response.name;
  renderItems();
  status.textContent = '版本 ' + response.version + ' · 歌单内容仅属于当前账号';
}
function renderItems() {
  rows.replaceChildren();
  if (!record) return;
  record.items.forEach((item, index) => {
    const row = element('li', 'named-playlist-item');
    const text = element('span', 'named-playlist-song');
    const artist = Array.isArray(item.song.artist) ? item.song.artist.join(' / ') : (item.song.artist || '');
    text.textContent = (index + 1) + '. ' + item.song.name + (artist ? ' · ' + artist : '');
    row.append(text);
    row.append(action('↑', () => moveItem(index, -1), 'named-playlist-small'));
    row.append(action('↓', () => moveItem(index, 1), 'named-playlist-small'));
    row.append(action('移除', () => removeItem(item.id), 'named-playlist-small is-danger'));
    rows.append(row);
  });
  if (!record.items.length) rows.append(element('li', 'named-playlist-empty', '这个歌单还是空的'));
}
async function renamePlaylist() {
  if (!record) return;
  const name = renameInput.value.trim();
  if (!name) return;
  const result = await apiRequest('/api/me/playlists/' + encodeURIComponent(record.id), { method: 'PATCH', body: { name }, ifMatch: ifMatch() });
  await refreshPlaylists(record.id);
  status.textContent = '歌单名称已更新';
}
async function deletePlaylist() {
  if (!record || !window.confirm('删除歌单“' + record.name + '”？')) return;
  const id = record.id;
  await apiRequest('/api/me/playlists/' + encodeURIComponent(id), { method: 'DELETE', body: {}, ifMatch: ifMatch() });
  await refreshPlaylists();
  status.textContent = '歌单已删除';
}
async function addQueue() {
  if (!record) return;
  let queue;
  try { queue = JSON.parse(safeGetLocalStorage('playlistSongs') || '[]'); } catch { queue = []; }
  if (!Array.isArray(queue) || !queue.length) { status.textContent = '系统队列为空'; return; }
  if (queue.length > 2000) { status.textContent = '队列超过歌单上限，请先整理后再添加'; return; }
  for (let start = 0; start < queue.length; start += 200) {
    const result = await apiRequest('/api/me/playlists/' + encodeURIComponent(record.id) + '/items/batch', {
      method: 'POST', body: { items: queue.slice(start, start + 200) }, ifMatch: ifMatch(),
    });
    record = result.playlist;
  }
  renderItems();
  status.textContent = '已将当前队列添加到命名歌单';
}
async function removeItem(itemId) {
  if (!record) return;
  record = await apiRequest('/api/me/playlists/' + encodeURIComponent(record.id) + '/items/' + encodeURIComponent(itemId), {
    method: 'DELETE', body: {}, ifMatch: ifMatch(),
  });
  title.textContent = record.name + ' · ' + record.items.length + ' 首';
  renderItems();
  status.textContent = '歌曲已移除';
}
async function moveItem(index, direction) {
  if (!record) return;
  const next = index + direction;
  if (next < 0 || next >= record.items.length) return;
  const ids = record.items.map(item => item.id);
  [ids[index], ids[next]] = [ids[next], ids[index]];
  record = await apiRequest('/api/me/playlists/' + encodeURIComponent(record.id) + '/order', {
    method: 'PUT', body: { itemIds: ids }, ifMatch: ifMatch(),
  });
  title.textContent = record.name + ' · ' + record.items.length + ' 首';
  renderItems();
}
function exportPlaylist() {
  if (!record) return;
  const payload = { formatVersion: 2, type: 'solara_playlist', name: record.name, items: record.items.map(item => item.song), exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url; link.download = record.name.replace(/[^\p{L}\p{N}_-]+/gu, '_') + '.json';
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
async function importFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { status.textContent = '导入文件超过 2 MiB'; return; }
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { status.textContent = '文件不是有效 JSON'; return; }
  const source = payload && typeof payload === 'object' ? payload : {};
  const songs = Array.isArray(payload) ? payload : (source.items || source.songs || source.playlistSongs || []);
  const name = String(source.name || createInput.value || file.name.replace(/\.json$/i, '')).trim().slice(0, 80);
  if (!Array.isArray(songs) || !songs.length || songs.length > 10000) { status.textContent = '文件中没有可导入的歌曲或超过 10000 首'; return; }
  if (!window.confirm('将 ' + songs.length + ' 首歌曲导入当前账号的歌单“' + name + '”？重复歌曲会跳过。')) return;
  const result = await apiRequest('/api/me/import', {
    method: 'POST',
    body: { formatVersion: 2, sourceType: 'json-v2', playlists: [{ name, items: songs }] },
  });
  await refreshPlaylists();
  status.textContent = '导入完成：待修复 ' + (result.unresolved || 0) + ' 条';
}
export async function openNamedPlaylistManager() {
  buildDialog();
  try {
    await refreshPlaylists();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  } catch (error) { status.textContent = error.message || '无法读取歌单'; }
}
