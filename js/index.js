'use strict';
import { bootstrapAuth, apiRequest } from './core/auth.js';
import { loadUserLibrary, initializeUserStorage } from './core/storage.js';
import { mountAccountBar } from './account-ui.js';
const startup=document.getElementById('authStartupStatus');
function announce(text,error=false){if(startup){startup.textContent=text;startup.dataset.error=error?'true':'false';startup.hidden=false}}
function readArray(key){try{const value=JSON.parse(localStorage.getItem(key)||'null');return Array.isArray(value)?value:[]}catch{return[]}}
function readLegacy(){
 const queue=readArray('playlistSongs'),favorites=readArray('favoriteSongs'),settings={};
 for(const key of ['playbackQuality','searchSource']){const value=localStorage.getItem(key);if(value!=null)settings[key]=value}
 const radar=localStorage.getItem('radarSettings');if(radar){try{settings.radarSettings=JSON.parse(radar)}catch{}}
 return{queue,favorites,settings};
}
async function importLegacy(user){
 const legacy=readLegacy(),count=legacy.queue.length+legacy.favorites.length;
 if(!count&&!Object.keys(legacy.settings).length)return false;
 if(!window.confirm('检测到此浏览器中的旧版本地数据。将 '+count+' 首歌曲及设置导入到账号“'+(user.displayName||user.username)+'”？导入只追加并跳过重复项。'))return false;
 const body={sourceType:'browser-v1'};
 if(legacy.queue.length)body.queue=legacy.queue;if(legacy.favorites.length)body.favorites=legacy.favorites;if(Object.keys(legacy.settings).length)body.settings=legacy.settings;
 await apiRequest('/api/me/import',{method:'POST',body});
 for(const key of ['playlistSongs','favoriteSongs','currentSong','currentTrackIndex','currentFavoriteIndex','currentPlaybackTime','playbackQuality','searchSource','radarSettings']){try{localStorage.removeItem(key)}catch{}}
 return true;
}
async function start(){
 try{
  const session=await bootstrapAuth();if(!session)return;
  const snapshot=await loadUserLibrary();await initializeUserStorage(session,snapshot);
  window.SolaraAccountName=session.user.displayName||session.user.username;
  const legacy=readLegacy(),hasLegacy=legacy.queue.length>0||legacy.favorites.length>0||Object.keys(legacy.settings).length>0;
  mountAccountBar(session.user,{
   hasLegacyData:hasLegacy,
   onLegacyImport:async()=>{if(await importLegacy(session.user))location.reload()},
   onRefresh:async()=>{await loadUserLibrary().then(data=>initializeUserStorage(session,data));location.reload()}
  });
  if(hasLegacy&&await importLegacy(session.user)){location.reload();return}
  window.addEventListener('solara:auth-invalid',()=>{announce('登录状态已失效，正在返回登录页…');location.replace('/login')},{once:true});
  window.__SOLARA_IS_MOBILE=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||window.innerWidth<760;
  const {bootstrap}=await import('./app.js');await bootstrap();
  if(window.__SOLARA_IS_MOBILE)await import('./mobile.js');
  startup?.remove();
 }catch(error){announce(error?.message||'Solara 启动失败，请刷新页面重试。',true);console.error('Solara startup failed',error)}
}
start();
