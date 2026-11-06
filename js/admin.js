'use strict';
import { apiRequest, bootstrapAuth } from './core/auth.js';
const usersNode=document.getElementById('users'), invitesNode=document.getElementById('invites'), statusNode=document.getElementById('adminStatus');
function button(label,run){const b=document.createElement('button');b.className='admin-button';b.type='button';b.textContent=label;b.addEventListener('click',async()=>{b.disabled=true;try{await run()}catch(e){statusNode.textContent=e.message||'操作失败'}finally{b.disabled=false}});return b}
function row(label,actions=[]){const d=document.createElement('div');d.className='admin-row';const span=document.createElement('span');span.textContent=label;const tools=document.createElement('div');tools.className='admin-actions';tools.append(...actions);d.append(span,tools);return d}
function showToken(url,label){const out=document.getElementById('inviteOutput');out.hidden=false;out.textContent=label+': '+url}
async function loadUsers(){
 const users=await apiRequest('/api/admin/users');usersNode.replaceChildren();
 for(const user of users){
  const actions=[
   button(user.status==='active'?'停用账号':'启用账号',async()=>{await apiRequest('/api/admin/users/'+encodeURIComponent(user.id),{method:'PATCH',body:{status:user.status==='active'?'disabled':'active'}});await loadUsers()}),
   button('生成重置链接',async()=>{const result=await apiRequest('/api/admin/users/'+encodeURIComponent(user.id)+'/reset-token',{method:'POST',body:{}});showToken(result.url,'重置链接（30 分钟有效，仅显示一次）')})
  ];
  usersNode.append(row(user.displayName+'  @'+user.username+' · '+user.role+' · '+user.status,actions));
 }
}
async function loadInvites(){
 const invites=await apiRequest('/api/admin/invites');invitesNode.replaceChildren();
 for(const invite of invites){
  const revoke=button('撤销',async()=>{await apiRequest('/api/admin/invites/'+encodeURIComponent(invite.id),{method:'DELETE',body:{}});await loadInvites()});
  invitesNode.append(row('邀请 · 到期 '+new Date(invite.expiresAt).toLocaleString(),[revoke]));
 }
}
document.getElementById('createInvite').addEventListener('click',async event=>{
 const b=event.currentTarget;b.disabled=true;
 try{const result=await apiRequest('/api/admin/invites',{method:'POST',body:{}});showToken(result.url,'邀请链接（七天有效，仅显示一次）');await loadInvites();statusNode.textContent='邀请已创建'}
 catch(e){statusNode.textContent=e.message||'创建邀请失败'}finally{b.disabled=false}
});
(async()=>{try{const session=await bootstrapAuth();if(!session)return;if(session.user.role!=='admin'){location.replace('/');return}await loadUsers();await loadInvites()}
 catch(e){statusNode.textContent=e.message||'无法读取管理数据';if(e.status===401||e.status===403)location.replace('/') }})();
