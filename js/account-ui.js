'use strict';
import { logout, apiRequest } from './core/auth.js';
import { getSyncStatus, getLibraryMetadata } from './core/storage.js';
import { openNamedPlaylistManager } from './core/named-playlists.js';
function button(label,className,handler){const element=document.createElement('button');element.type='button';element.className=className;element.textContent=label;element.addEventListener('click',handler);return element}
function createResumeDialog(){
 const dialog=document.createElement('dialog');dialog.className='named-playlist-dialog';
 const shell=document.createElement('div');shell.className='named-playlist-shell';
 const title=document.createElement('h2');title.textContent='恢复其他设备的进度';
 const status=document.createElement('p');status.className='named-playlist-status';status.textContent='正在读取设备…';
 const list=document.createElement('div');list.className='named-playlist-rows';
 const close=document.createElement('button');close.type='button';close.className='named-playlist-action';close.textContent='关闭';close.addEventListener('click',()=>dialog.close());
 shell.append(title,status,list,close);dialog.append(shell);document.body.append(dialog);return{dialog,status,list};
}
export function mountAccountBar(user,options={}){
 const existing=document.getElementById('solaraAccountBar');if(existing)existing.remove();
 const bar=document.createElement('aside');bar.id='solaraAccountBar';bar.className='solara-account-bar';bar.setAttribute('aria-label','账号与同步');
 const identity=document.createElement('div');identity.className='solara-account-identity';
 const name=document.createElement('strong');name.textContent=user.displayName||user.username;
 const username=document.createElement('span');username.textContent='@'+user.username;identity.append(name,username);
 const status=document.createElement('span');status.className='solara-sync-status';status.setAttribute('role','status');
 const refresh=button('刷新数据','solara-account-button',async()=>{refresh.disabled=true;try{await options.onRefresh?.()}catch(error){status.textContent=error.message||'刷新失败'}finally{refresh.disabled=false}});
 const playlists=button('命名歌单','solara-account-button',()=>openNamedPlaylistManager());
 const resume=button('恢复设备进度','solara-account-button',async()=>{
  resume.disabled=true;const view=createResumeDialog();
  try{
   const devices=await apiRequest('/api/me/devices');view.list.replaceChildren();
   if(!devices.length){view.status.textContent='没有其他设备的播放记录。';return}
   view.status.textContent='选择要恢复的设备进度；恢复后会覆盖此设备当前进度。';
   for(const device of devices){
    const row=document.createElement('div');row.className='named-playlist-row';
    const label=document.createElement('span');const date=new Date(device.updatedAt).toLocaleString();
    label.textContent=date+' · '+(device.state?.source||'')+':'+(device.state?.trackId||'播放记录');
    const use=button('恢复','named-playlist-action',async()=>{
     if(!window.confirm('将此设备的播放进度恢复到当前设备？当前设备进度会被替换。'))return;
     use.disabled=true;
     try{const metadata=getLibraryMetadata();await apiRequest('/api/me/playback/resume',{method:'POST',body:{sourceDeviceId:device.deviceId},ifMatch:'"v'+metadata.playbackVersion+'"'});view.dialog.close();location.reload()}
     catch(error){view.status.textContent=error.message||'恢复失败';use.disabled=false}
    });
    row.append(label,use);view.list.append(row);
   }
  }catch(error){view.status.textContent=error.message||'读取设备失败'}
  finally{resume.disabled=false}
 });
 const legacy=button('导入旧数据','solara-account-button solara-account-button--accent',async()=>{legacy.disabled=true;try{await options.onLegacyImport?.()}catch(error){status.textContent=error.message||'导入失败'}finally{legacy.disabled=false}});
 legacy.hidden=!options.hasLegacyData;
 const admin=document.createElement('a');admin.className='solara-account-button';admin.href='/admin';admin.textContent='账号管理';admin.hidden=user.role!=='admin';
 const signOut=button('退出','solara-account-button',async()=>{signOut.disabled=true;try{await logout()}catch(error){status.textContent=error.message||'退出失败';signOut.disabled=false}});
 bar.append(identity,status,refresh,playlists,resume,legacy,admin,signOut);document.body.append(bar);
 const show=value=>{status.dataset.state=value.state;status.textContent=value.message||'已同步'};show(getSyncStatus());
 window.addEventListener('solara:sync-status',event=>show(event.detail||getSyncStatus()));
 window.addEventListener('solara:auth-invalid',event=>{
  if(document.getElementById('solaraAccountLock'))return;
  const lock=document.createElement('div');lock.id='solaraAccountLock';lock.className='solara-account-lock';lock.textContent='账号状态已变化，正在重新验证…';document.body.append(lock);
  const reason=event.detail?.reason||'';window.setTimeout(()=>window.location.replace(reason==='logout'?'/login':'/'),80);
 },{once:true});
 return bar;
}
