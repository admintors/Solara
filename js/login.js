'use strict';
import { getDeviceId, announceLogin } from './core/auth.js';
const params = new URLSearchParams(location.hash.slice(1));
const inviteToken = params.get('invite') || '';
const resetToken = params.get('reset') || '';
if (inviteToken || resetToken) history.replaceState(null, '', location.pathname + location.search);
const panels={login:document.getElementById('login-panel'),register:document.getElementById('register-panel'),reset:document.getElementById('reset-panel')};
const message=document.getElementById('auth-message');
function show(panel,text=''){for(const [name,node] of Object.entries(panels))node.hidden=name!==panel;message.textContent=text}
function setBusy(form,value){for(const node of form.querySelectorAll('button,input'))node.disabled=value}
async function post(path,body){
 const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(payload?.error?.message||'请求失败，请稍后重试');
 return payload.data;
}
document.getElementById('login-form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget;setBusy(form,true);
 try{await post('/api/auth/login',{username:document.getElementById('login-username').value.trim(),password:document.getElementById('login-password').value,deviceId:getDeviceId()});announceLogin();location.replace('/')}
 catch(error){message.textContent=error.message}finally{setBusy(form,false)}
});
document.getElementById('register-form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget;if(!inviteToken){message.textContent='注册需要有效的邀请链接。';return}setBusy(form,true);
 try{await post('/api/auth/register',{inviteToken,username:document.getElementById('register-username').value.trim(),displayName:document.getElementById('register-display').value.trim(),password:document.getElementById('register-password').value,deviceId:getDeviceId()});announceLogin();location.replace('/')}
 catch(error){message.textContent=error.message}finally{setBusy(form,false)}
});
document.getElementById('reset-form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget;if(!resetToken){message.textContent='密码重置链接无效或已失效。';return}setBusy(form,true);
 try{await post('/api/auth/reset-password',{token:resetToken,password:document.getElementById('reset-password').value});show('login','密码已更新，请使用新密码登录。')}
 catch(error){message.textContent=error.message}finally{setBusy(form,false)}
});
if(inviteToken)show('register');else if(resetToken)show('reset');else show('login');
