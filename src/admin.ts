export const adminHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iMessage 桥接设置</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;background:#101512;color:#e8efe9}
*{box-sizing:border-box}body{margin:0;padding:64px 20px}main{max-width:520px;margin:auto}header{margin-bottom:32px}
.badge{color:#a7c9af;font-size:13px;letter-spacing:2px}h1{font-size:28px;font-weight:600;margin:12px 0}p{color:#aebcb2;line-height:1.7;font-size:14px}
form{background:#19211c;border:1px solid #334338;border-radius:20px;padding:28px}label{display:block;font-size:15px;margin-bottom:12px}
input[type=password],input[type=text]{width:100%;padding:13px;border-radius:9px;border:1px solid #4e6254;background:#111813;color:inherit;font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid #b3e8c0;outline-offset:3px}.row{display:flex;justify-content:space-between;align-items:center;margin-top:28px;gap:20px}.row label{margin:0}input[type=checkbox]{width:22px;height:22px;accent-color:#b3e8c0}
button{padding:12px 18px;border:0;border-radius:9px;background:#b3e8c0;color:#15251a;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;gap:12px;margin-top:24px}.secondary{background:transparent;color:#c1cec4;border:1px solid #4e6254}
#status{min-height:24px;margin:16px 4px;color:#c3dfcb}small{display:block;color:#aebcb2;margin-top:10px;line-height:1.6}[hidden]{display:none!important}
</style>
<main><header><div class="badge">PHOTON · IMESSAGE</div><h1>桥接设置</h1><p>让下一条回复，用你喜欢的方式到来。</p></header>
<form id="login"><label for="secret">管理密钥</label><input id="secret" type="password" required autocomplete="current-password" placeholder="输入 BRIDGE_SECRET"><small>密钥仅用于本页解锁，刷新页面后需重新输入。</small><div class="actions"><button>解锁设置</button></div></form>
<form id="settings" hidden><label for="model">回复模型</label><input id="model" type="text" maxlength="200" placeholder="使用网关默认模型" autocomplete="off" spellcheck="false"><small>填写网关支持的模型 ID，留空使用网关默认模型。</small>
<div class="row"><label for="time">附带当前时间</label><input id="time" type="checkbox" role="switch"></div><small>东八区 · 精确到秒 · 显示星期。关闭后仍保留 iMessage 来源标记。</small>
<div class="actions"><button id="save">保存设置</button><button id="lock" type="button" class="secondary">锁定</button></div><small>保存后从下一条消息生效，无需重启。</small></form>
<p id="status" role="status" aria-live="polite"></p></main>
<script>
const $=id=>document.getElementById(id);let secret='';
async function api(method,body){const response=await fetch('/api/settings',{method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});if(!response.ok)throw new Error(response.status===401?'密钥不正确，请重新解锁。':method==='PUT'?'保存失败，请检查模型 ID 或稍后重试。':'读取失败，请稍后重试。');return response.json()}
$('login').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;secret=$('secret').value.trim();$('status').textContent='正在读取…';try{const data=await api('GET');$('model').value=data.model;$('time').checked=data.timeEnabled;$('secret').value='';$('login').hidden=true;$('settings').hidden=false;$('status').textContent='';$('model').focus()}catch(error){secret='';$('status').textContent=error.message}finally{button.disabled=false}});
$('settings').addEventListener('submit',async event=>{event.preventDefault();$('save').disabled=true;$('lock').disabled=true;$('status').textContent='正在保存…';try{const data=await api('PUT',{model:$('model').value.trim(),timeEnabled:$('time').checked});$('model').value=data.model;$('time').checked=data.timeEnabled;$('status').textContent='已保存，下一条消息生效。'}catch(error){$('status').textContent=error.message}finally{$('save').disabled=false;$('lock').disabled=false}});
$('lock').addEventListener('click',()=>{secret='';$('settings').reset();$('settings').hidden=true;$('login').hidden=false;$('status').textContent='已锁定。';$('secret').focus()});
</script></html>`;
