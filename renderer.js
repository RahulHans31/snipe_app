const $ = (id) => document.getElementById(id);
let state;
let lanes = [];
let logFilter = 'ALL';
let logSearch = '';
let toastTimer;
let laneTicker = null;
const defaults = { targets: [], settings: { pincode:'', paymentMode:'off', quantity:1, pollInterval:3, parallelism:2, sound:false }, events:[], accounts:[], cards:[], orders:[] };
function productFromUrl(raw){ try { const url=new URL(raw); if(!/(^|\.)flipkart\.com$/.test(url.hostname)) throw Error('Use a flipkart.com URL.'); const productId=url.searchParams.get('pid'); if(!productId) throw Error('URL must include ?pid=.'); const slug=url.pathname.split('/').filter(Boolean)[0]||'Product'; return {id:crypto.randomUUID(),productId,listingId:url.searchParams.get('lid')||null,url:raw,name:slug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}; } catch(e){ throw Error(e.message==='Invalid URL.'?'Enter a valid URL.':e.message); } }
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(text,kind='ok'){const el=$('toast');el.textContent=text||'';el.dataset.kind=kind;clearTimeout(toastTimer);if(text)toastTimer=setTimeout(()=>{el.textContent='';delete el.dataset.kind;},4000);}
// Short WebAudio beep — no bundled files needed. Frequency picks event kind
// so a hit and a failure sound different without training.
let audioCtx=null;
function beep(kind){
  if(!state?.settings?.sound)return;
  try{
    audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    const freq=kind==='ok'?880:kind==='err'?220:kind==='hit'?660:520;
    const now=audioCtx.currentTime;
    const osc=audioCtx.createOscillator();const gain=audioCtx.createGain();
    osc.type='sine';osc.frequency.value=freq;
    gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(0.15,now+0.02);gain.gain.linearRampToValueAtTime(0,now+0.22);
    osc.connect(gain).connect(audioCtx.destination);osc.start(now);osc.stop(now+0.25);
  }catch{}
}
function accountCount(){return state.accounts?.length||1;}
function targetSubline(t){const fanout=accountCount();return `PID ${escapeHtml(t.productId||'?')} · ${fanout} account${fanout===1?'':'s'}${state.accounts?.length?'':' (current session)'}`;}
function render(){ renderCards(); $('target-count').textContent=`${state.targets.length} READY`; const map={pincode:'pincode',payment:'paymentMode',quantity:'quantity',poll:'pollInterval',parallelism:'parallelism',bank:'bank',vpa:'vpa',addressId:'addressId',addressPincode:'addressPincode',telegramToken:'telegramToken',telegramChatId:'telegramChatId'}; for(const [id,key] of Object.entries(map)) $(id).value=state.settings[key]??''; for(const id of ['conditionalBuy','supercoins','gst']) $(id).checked=state.settings[id]===true; for(const id of ['notifyPlaced','notifyFailed']) $(id).checked=state.settings[id]!==false; if($('sound'))$('sound').checked=state.settings.sound===true; $('target-list').innerHTML=state.targets.length?state.targets.map(t=>`<div class="target"><div><div class="target-name">${escapeHtml(t.name)}</div><div class="target-url">${targetSubline(t)}</div></div><button class="remove" data-id="${t.id}">REMOVE</button></div>`).join(''):'<div class="empty">No targets acquired.<br><span class="hint">Paste a Flipkart product URL containing <code>?pid=</code>. Example: <code>flipkart.com/nothing-phone-1/p/itmxxx?pid=MOBGCDMK9F9EYT4T</code></span></div>'; $('account-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<div class="target"><div><div class="target-name">${escapeHtml(a.name)}</div><div class="target-url">${a.cookies?.length||0} cookies · saved account</div></div><button class="remove account-remove" data-id="${a.id}">REMOVE</button></div>`).join(''):'<div class="empty">No saved accounts.<br><span class="hint">Use LOGIN VIA OTP for new sessions, or CAPTURE CURRENT to save the browser cookies you already have.</span></div>'; validateFields(); renderLog(); renderLanes(); }
function updateConditionalFields(){ const mode=$('payment').value; $('bank').closest('label').parentElement.hidden=mode!=='netbank'; $('vpa').closest('label').parentElement.hidden=mode!=='upi'; $('addressId').closest('label').parentElement.hidden=!['cod','upi','netbank','creditcard','emi'].includes(mode); if($('card-mgmt'))$('card-mgmt').hidden=mode!=='creditcard'; }
function last4(pan){const digits=String(pan||'').replace(/\D/g,'');return digits.length>=4?digits.slice(-4):digits;}
function normalizeExpiry(v){const digits=String(v||'').replace(/\D/g,'').slice(0,4);if(digits.length<3)return digits;return `${digits.slice(0,2)}/${digits.slice(2)}`;}
function detectNetwork(pan){const d=String(pan||'').replace(/\D/g,'');if(/^4/.test(d))return 'Visa';if(/^(5[1-5]|2[2-7])/.test(d))return 'Mastercard';if(/^3[47]/.test(d))return 'Amex';if(/^6(?:0|5)/.test(d))return 'RuPay';return '';}
function renderCards(){const list=$('cards-list');const sel=$('card-select');if(!list||!sel)return;const cards=state.cards||[];$('cards-count').textContent=cards.length;const opts=['<option value="">— none —</option>',...cards.map(c=>`<option value="${escapeHtml(c.id)}"${state.selectedCardId===c.id?' selected':''}>${escapeHtml(c.nickname||'Card')} · •••• ${escapeHtml(c.lastFour||'')}${c.network?` · ${escapeHtml(c.network)}`:''}</option>`)];sel.innerHTML=opts.join('');list.innerHTML=cards.length?cards.map(c=>`<div class="order"><div><strong>${escapeHtml(c.nickname||'Card')}</strong> · •••• ${escapeHtml(c.lastFour||'')}${c.network?` · ${escapeHtml(c.network)}`:''}</div><div>${escapeHtml(c.holderName||'')} · exp ${escapeHtml(c.expiry||'')}<button class="remove card-remove" data-id="${escapeHtml(c.id)}">REMOVE</button></div></div>`).join(''):'<div class="empty">No saved cards.<br><span class="hint">Add a card above. Number and CVV are stored encrypted; anyone with your Windows profile can decrypt them.</span></div>';}
function openCardForm(){$('card-form').hidden=false;['card-nickname','card-holder','card-number','card-expiry','card-cvv'].forEach(id=>{$(id).value='';});$('card-nickname').focus();}
function closeCardForm(){$('card-form').hidden=true;}
function validateFields(){
  const rules=[
    ['pincode',/^\d{6}$/],
    ['addressPincode',/^\d{6}$/],
    ['vpa',/^[\w.\-]{2,}@[a-z]{2,}$/i],
  ];
  for(const [id,re] of rules){const el=$(id);if(!el)continue;const val=el.value.trim();if(!val)delete el.dataset.valid;else el.dataset.valid=re.test(val)?'ok':'err';}
}
function eventMatchesFilter(e){if(logFilter!=='ALL'&&(e.kind||'info')!==logFilter)return false;if(logSearch&&!(e.text||'').toLowerCase().includes(logSearch))return false;return true;}
function decorateOrderRefs(text){return String(text).replace(/(OD\d{16,18})/g,'<span class="orderref" data-ref="$1">$1<button class="copyref" title="Copy order ref">📋</button></span>');}
function eventHtml(e){return `<div class="event" data-kind="${escapeHtml(e.kind||'info')}"><time>${new Date(e.at).toLocaleTimeString()}</time>${decorateOrderRefs(escapeHtml(e.text))}</div>`;}
function renderLog(){const events=(state.events||[]).filter(eventMatchesFilter);$('log').innerHTML=events.length?events.map(eventHtml).join(''):'<div class="empty">System idle.</div>';}
function appendEvent(e){state.events=[e,...(state.events||[])].slice(0,100);beep(e.kind);if(!eventMatchesFilter(e))return;const log=$('log');if(log.querySelector('.empty'))log.innerHTML='';const wasAtTop=log.scrollTop<=6;log.insertAdjacentHTML('afterbegin',eventHtml(e));while(log.childElementCount>100)log.lastElementChild.remove();if(wasAtTop)log.scrollTop=0;}
function fmtElapsed(ms){const s=Math.max(0,Math.floor(ms/1000));return s<60?`${s}s`:`${Math.floor(s/60)}m${s%60}s`;}
function fmtWhen(ts){const d=new Date(ts);return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;}
function renderOrders(){const el=$('orders-list');if(!el)return;const orders=state.orders||[];$('orders-count').textContent=orders.length;el.innerHTML=orders.length?orders.map(o=>`<div class="order"><div><strong>${escapeHtml(o.orderRef||'—')}</strong> · ${escapeHtml(o.targetName||'')}</div><div>${escapeHtml(o.accountName||'')} · ${fmtWhen(o.at)}${o.grandTotal?` · ₹${escapeHtml(String(o.grandTotal))}`:''}</div></div>`).join(''):'<div class="empty">No orders yet.<br><span class="hint">Successful checkouts land here with their OD… reference.</span></div>';}
function renderPresets(){const el=$('presets-list');if(!el)return;const presets=state.presets||[];el.innerHTML=presets.length?presets.map(p=>`<div class="preset"><span>${escapeHtml(p.name)}</span><span><button class="load" data-load="${escapeHtml(p.name)}">LOAD</button> <button data-del="${escapeHtml(p.name)}">DELETE</button></span></div>`).join(''):'<div class="empty">No presets saved.<br><span class="hint">Save your current runtime settings as a preset for quick switching between drop configurations.</span></div>';}
function drawSparkline(values){const svg=$('latency-spark');if(!svg)return;if(!values||!values.length){svg.innerHTML='';return;}const w=120,h=24;const max=Math.max(...values,1);const step=values.length>1?w/(values.length-1):0;const points=values.map((v,i)=>`${(i*step).toFixed(1)},${(h-(v/max)*h).toFixed(1)}`).join(' ');const avg=values.reduce((a,b)=>a+b,0)/values.length;svg.innerHTML=`<polyline points="${points}"/>`;svg.setAttribute('title',`poll RTT last ${values.length} · avg ${Math.round(avg)}ms · max ${max}ms`);}
function renderLanes(){const el=$('lanes');if(!lanes.length){el.innerHTML='';stopLaneTicker();return;}const now=Date.now();el.innerHTML=lanes.map(l=>{const elapsed=l.startedAt?fmtElapsed(now-l.startedAt):'';return `<div class="lane" data-phase="${escapeHtml(l.phase)}"><span>${escapeHtml(l.label)}</span><span>${escapeHtml(l.phase.toUpperCase())}${l.detail?` · ${escapeHtml(l.detail)}`:''}${elapsed?` · ${elapsed}`:''}</span></div>`;}).join('');startLaneTicker();}
function startLaneTicker(){if(laneTicker)return;const anyRunning=()=>lanes.some(l=>['queued','running','payment','upi'].includes(l.phase));if(!anyRunning())return;laneTicker=setInterval(()=>{if(!anyRunning()){stopLaneTicker();return;}renderLanes();},1000);}
function stopLaneTicker(){if(laneTicker){clearInterval(laneTicker);laneTicker=null;}}
async function save(){ state.settings={...state.settings,pincode:$('pincode').value.trim(),paymentMode:$('payment').value,quantity:Number($('quantity').value),pollInterval:Number($('poll').value),parallelism:Number($('parallelism').value),bank:$('bank').value.trim(),vpa:$('vpa').value.trim(),addressId:$('addressId').value.trim(),addressPincode:$('addressPincode').value.trim(),conditionalBuy:$('conditionalBuy').checked,supercoins:$('supercoins').checked,gst:$('gst').checked,telegramToken:$('telegramToken').value.trim(),telegramChatId:$('telegramChatId').value.trim(),notifyPlaced:$('notifyPlaced').checked,notifyFailed:$('notifyFailed').checked,sound:$('sound')?.checked===true}; await window.snipe.saveState(state); validateFields();}
$('add').onclick=async()=>{try{const t=productFromUrl($('url').value.trim());state.targets.push(t);$('url').value='';$('error').textContent='';await window.snipe.saveState(state);render();toast(`Target added: ${t.name}`);}catch(e){$('error').textContent=e.message;}};
$('url').onkeydown=e=>{if(e.key==='Enter')$('add').click()};
$('target-list').onclick=async e=>{if(e.target.classList.contains('remove')){state.targets=state.targets.filter(t=>t.id!==e.target.dataset.id);await window.snipe.saveState(state);render();}};
['pincode','payment','quantity','poll','parallelism','bank','vpa','addressId','addressPincode','conditionalBuy','supercoins','gst','telegramToken','telegramChatId','notifyPlaced','notifyFailed'].forEach(id=>$(id).addEventListener('change',save));
['pincode','vpa','addressPincode'].forEach(id=>$(id).addEventListener('input',validateFields));
$('payment').addEventListener('change',updateConditionalFields);
if($('add-card-btn'))$('add-card-btn').onclick=openCardForm;
if($('card-cancel'))$('card-cancel').onclick=closeCardForm;
if($('card-number'))$('card-number').addEventListener('input',e=>{const digits=e.target.value.replace(/\D/g,'').slice(0,19);e.target.value=digits.replace(/(\d{4})(?=\d)/g,'$1 ').trim();});
if($('card-expiry'))$('card-expiry').addEventListener('input',e=>{e.target.value=normalizeExpiry(e.target.value);});
if($('card-cvv'))$('card-cvv').addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,4);});
if($('card-save'))$('card-save').onclick=async()=>{
  const nickname=$('card-nickname').value.trim();
  const holderName=$('card-holder').value.trim();
  const number=$('card-number').value.replace(/\s+/g,'');
  const expiry=$('card-expiry').value.trim();
  const cvv=$('card-cvv').value.trim();
  if(!nickname){toast('Nickname required','err');return;}
  if(!/^\d{13,19}$/.test(number)){toast('Card number must be 13–19 digits','err');return;}
  if(!/^\d{2}\/\d{2}$/.test(expiry)){toast('Expiry must be MM/YY','err');return;}
  if(!/^\d{3,4}$/.test(cvv)){toast('CVV must be 3 or 4 digits','err');return;}
  const id=`card_${Date.now()}`;
  const network=detectNetwork(number);
  const card={id,nickname,holderName,number,expiry,cvv,network,lastFour:last4(number),savedAt:Date.now()};
  state.cards=[...(state.cards||[]),card];
  if(!state.selectedCardId)state.selectedCardId=id;
  await window.snipe.saveState(state);
  closeCardForm();
  renderCards();
  toast(`Card saved: ${nickname} ····${card.lastFour}`);
};
if($('card-select'))$('card-select').onchange=async e=>{state.selectedCardId=e.target.value||null;await window.snipe.saveState(state);};
if($('cards-list'))$('cards-list').addEventListener('click',async e=>{
  if(!e.target.classList.contains('card-remove'))return;
  const id=e.target.dataset.id;
  state.cards=(state.cards||[]).filter(c=>c.id!==id);
  if(state.selectedCardId===id)state.selectedCardId=null;
  await window.snipe.saveState(state);
  renderCards();
});
async function addCapturedAccount(source,cookies,name){const cleanName=String(name||'').trim();if(!cleanName){$('error').textContent='Enter an account nickname.';return false}state.accounts.push({id:`acct_${Date.now()}`,name:cleanName,source,cookies,capturedAt:Date.now()});await window.snipe.saveState(state);render();toast(`Account saved: ${cleanName}`);return true;}
let accountCaptureSource='current';
function openAccountForm(source){accountCaptureSource=source;$('account-form').hidden=false;$('cookie-header-field').hidden=source!=='paste';$('account-nickname').value='';$('account-cookie-header').value='';$('account-nickname').focus();}
function closeAccountForm(){$('account-form').hidden=true;$('account-nickname').value='';$('account-cookie-header').value='';}
$('capture-account').onclick=()=>openAccountForm('current');
$('paste-account').onclick=()=>openAccountForm('paste');
$('cancel-account').onclick=closeAccountForm;
$('save-account').onclick=async()=>{const name=$('account-nickname').value.trim();if(!name){$('error').textContent='Enter an account nickname.';return}$('save-account').disabled=true;let result;if(accountCaptureSource==='current')result=await window.snipe.captureCurrentAccount();else result=await window.snipe.parseAccountCookies($('account-cookie-header').value.trim());$('save-account').disabled=false;if(!result?.ok){$('error').textContent=result?.error||'Account capture failed.';return}if(await addCapturedAccount(accountCaptureSource==='current'?'electron-session':'cookie-header',result.cookies,name))closeAccountForm();};
let loginRequestId=null;
function loginStatus(text,kind='info'){$('login-status').textContent=text||'';$('login-status').dataset.kind=kind;}
function resetLogin(){window.snipe.cancelLogin().catch(()=>{});$('login-form').hidden=true;$('login-nickname').value='';$('login-phone').value='';$('login-otp').value='';$('otp-step').hidden=true;loginRequestId=null;loginStatus('');}
$('login-account').onclick=()=>{resetLogin();$('login-form').hidden=false;$('login-nickname').focus();};
$('cancel-login').onclick=resetLogin;
$('send-otp').onclick=async()=>{const phone=$('login-phone').value.trim();if(!phone){loginStatus('Enter a mobile or email first.','err');return}$('send-otp').disabled=true;loginStatus('Sending OTP…');const result=await window.snipe.sendLoginOtp(phone);$('send-otp').disabled=false;if(!result?.ok){loginStatus(result?.error||'Send OTP failed.','err');return}loginRequestId=result.requestId;$('otp-step').hidden=false;loginStatus(`OTP sent${result.emailMask?` to ${result.emailMask}`:result.smsServers?' by SMS':''}.`,'ok');$('login-otp').focus();};
$('resend-otp').onclick=()=>$('send-otp').click();
$('verify-otp').onclick=async()=>{const otp=$('login-otp').value.trim();if(!loginRequestId)return loginStatus('Send OTP first.','err');if(!otp)return loginStatus('Enter the OTP.','err');$('verify-otp').disabled=true;loginStatus('Verifying…');const result=await window.snipe.verifyLoginOtp({phone:$('login-phone').value.trim(),otp,requestId:loginRequestId});$('verify-otp').disabled=false;if(!result?.ok){loginStatus(result?.error||'Login failed.','err');return}const nickname=$('login-nickname').value.trim()||`Account ${state.accounts.length+1}`;await addCapturedAccount('login',result.cookies,nickname);loginStatus(`Logged in · ${result.cookieCount} cookies · saved`,'ok');setTimeout(resetLogin,1200);};
$('login-phone').onkeydown=e=>{if(e.key==='Enter')$('send-otp').click()};
$('login-otp').onkeydown=e=>{if(e.key==='Enter')$('verify-otp').click()};
$('account-list').onclick=async e=>{if(e.target.classList.contains('account-remove')){state.accounts=state.accounts.filter(a=>a.id!==e.target.dataset.id);await window.snipe.saveState(state);render();}};
$('push-address-btn').onclick=()=>{$('address-form').hidden=false;$('addr-name').focus();};
$('addr-cancel').onclick=()=>{$('address-form').hidden=true;$('addr-status').textContent='';};
$('addr-submit').onclick=async()=>{
  const addressData={name:$('addr-name').value.trim(),phone:$('addr-phone').value.trim(),addressLine1:$('addr-line1').value.trim(),addressLine2:$('addr-line2').value.trim(),city:$('addr-city').value.trim(),state:$('addr-state').value.trim(),pincode:$('addr-pincode').value.trim(),locationTypeTag:$('addr-type').value};
  if(!addressData.name||!addressData.phone||!addressData.addressLine1||!addressData.city||!addressData.state||!addressData.pincode){$('addr-status').textContent='Fill all required fields.';return;}
  if(!/^\d{10}$/.test(addressData.phone)){$('addr-status').textContent='Phone must be 10 digits (no +91).';return;}
  if(!/^\d{6}$/.test(addressData.pincode)){$('addr-status').textContent='Pincode must be 6 digits.';return;}
  if(!state.accounts.length){$('addr-status').textContent='No saved accounts.';return;}
  $('addr-submit').disabled=true;
  $('addr-status').textContent=`Pushing to ${state.accounts.length} account${state.accounts.length===1?'':'s'}…`;
  const result=await window.snipe.pushAddressToAll(addressData);
  $('addr-submit').disabled=false;
  if(!result?.ok){$('addr-status').textContent=result?.error||'Failed.';return;}
  const ok=result.results.filter(r=>r.ok).length;
  const fail=result.results.filter(r=>!r.ok).length;
  $('addr-status').textContent=`Done: ${ok} added${fail?`, ${fail} failed`:'.'}`;
  toast(`Address pushed to ${ok}/${result.results.length} account${result.results.length===1?'':'s'}`);
};
$('import-data').onclick=async()=>{const result=await window.snipe.importExtensionData();if(result?.ok){state=result.state;state.settings={...defaults.settings,...state.settings};render();toast('Extension data imported');}else if(result?.error)$('error').textContent=result.error;};
$('export-data').onclick=async()=>{const result=await window.snipe.exportDesktopData();if(result?.ok)toast(`Backup saved: ${result.path}`);else if(result?.error)$('error').textContent=result.error;};
document.querySelectorAll('.log-filters button').forEach(btn=>{btn.addEventListener('click',()=>{logFilter=btn.dataset.filter;document.querySelectorAll('.log-filters button').forEach(b=>b.classList.toggle('active',b===btn));renderLog();});});
function switchTab(name){document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('[data-tab-panel]').forEach(p=>{p.hidden=p.dataset.tabPanel!==name;});if(name==='orders')renderOrders();if(name==='presets')renderPresets();}
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
$('log-search')?.addEventListener('input',e=>{logSearch=e.target.value.trim().toLowerCase();renderLog();});
const PRESET_KEYS=['pincode','paymentMode','quantity','pollInterval','parallelism','bank','vpa','addressId','addressPincode','conditionalBuy','supercoins','gst','sound'];
function extractPresetSettings(){const out={};for(const k of PRESET_KEYS)out[k]=state.settings[k];return out;}
$('save-preset')?.addEventListener('click',async()=>{const name=$('preset-name').value.trim();if(!name){toast('Enter a preset name first','err');return;}await save();state.presets=[{name,settings:extractPresetSettings(),savedAt:Date.now()},...(state.presets||[]).filter(p=>p.name!==name)];await window.snipe.saveState(state);$('preset-name').value='';renderPresets();toast(`Preset "${name}" saved`);});
$('presets-list')?.addEventListener('click',async e=>{
  const loadName=e.target.dataset.load;const delName=e.target.dataset.del;
  if(loadName){const p=(state.presets||[]).find(x=>x.name===loadName);if(!p)return;state.settings={...state.settings,...p.settings};await window.snipe.saveState(state);render();updateConditionalFields();toast(`Preset "${loadName}" loaded`);}
  else if(delName){state.presets=(state.presets||[]).filter(p=>p.name!==delName);await window.snipe.saveState(state);renderPresets();toast(`Preset "${delName}" removed`,'info');}
});
$('log')?.addEventListener('click',async e=>{if(e.target.classList.contains('copyref')){const wrap=e.target.closest('.orderref');if(!wrap)return;try{await navigator.clipboard.writeText(wrap.dataset.ref);toast(`Copied ${wrap.dataset.ref}`);}catch{toast('Clipboard blocked','err');}}});
if($('token-toggle')){$('token-toggle').onclick=()=>{const f=$('telegramToken');const shown=f.type==='text';f.type=shown?'password':'text';$('token-toggle').textContent=shown?'👁':'🙈';};}
if($('test-telegram')){$('test-telegram').onclick=async()=>{await save();$('test-telegram').disabled=true;const r=await window.snipe.testTelegram();$('test-telegram').disabled=false;if(r?.ok)toast('Telegram test sent');else toast(r?.error||'Telegram test failed','err');};}
$('session').onclick=()=>window.snipe.openSession();
let engaged=false;
async function toggleEngage(){
  if(engaged){ await window.snipe.stop(); engaged=false; $('status').textContent='STANDBY'; $('engage').textContent='ENGAGE'; return; }
  if(!state.targets.length){$('error').textContent='Add at least one target.';return}
  await save(); engaged=true; $('status').textContent='ENGAGED'; $('engage').textContent='STOP LANES';
  const laneCount=Math.max(1,Number(state.settings.parallelism)||1); const targets=state.targets.map((t,i)=>({...t,lane:(i%laneCount)+1}));
  await window.snipe.launch({targets,config:state.settings});
}
// Hold-to-confirm on STOP LANES prevents accidental fat-finger stops during a
// drop. First click when engaged flips into "hold" mode; releasing before 1s
// cancels. Only applies when currently engaged.
let holdTimer=null;let holding=false;
$('engage').addEventListener('mousedown',()=>{if(!engaged)return;holding=true;$('engage').textContent='HOLD…';holdTimer=setTimeout(()=>{if(holding){holding=false;$('engage').textContent='STOPPING';toggleEngage();}},900);});
$('engage').addEventListener('mouseup',()=>{if(!engaged||!holding)return;holding=false;clearTimeout(holdTimer);holdTimer=null;$('engage').textContent='STOP LANES';toast('Hold STOP LANES for 1s to confirm','info');});
$('engage').addEventListener('mouseleave',()=>{if(!holding)return;holding=false;clearTimeout(holdTimer);holdTimer=null;$('engage').textContent='STOP LANES';});
$('engage').onclick=e=>{if(engaged){e.preventDefault();return;}toggleEngage();};
$('clear').onclick=async()=>{state.events=[];await window.snipe.saveState(state);renderLog();};
document.addEventListener('keydown',e=>{
  if(e.target.matches('input,textarea,select'))return;
  if((e.ctrlKey||e.metaKey)&&e.key==='e'){e.preventDefault();toggleEngage();}
  else if((e.ctrlKey||e.metaKey)&&e.key==='l'){e.preventDefault();$('clear').click();}
  else if((e.ctrlKey||e.metaKey)&&e.key==='n'){e.preventDefault();$('url').focus();}
  else if(e.key==='Escape'){closeAccountForm();if(!$('login-form').hidden)resetLogin();}
});
window.snipe.onMenuAction?.(({action})=>{
  if(action==='engage-toggle')toggleEngage();
  else if(action==='stop-all'){if(engaged)toggleEngage();}
  else if(action==='import')$('import-data').click();
  else if(action==='export')$('export-data').click();
});
window.snipe.onEvent(appendEvent);
window.snipe.onLanes(list=>{lanes=Array.isArray(list)?list:[];renderLanes();});
window.snipe.onOrders?.(orders=>{state.orders=Array.isArray(orders)?orders:[];if(document.querySelector('[data-tab-panel="orders"]:not([hidden])'))renderOrders();});
window.snipe.onMetrics?.(m=>{drawSparkline(m?.pollRtt||[]);});
window.snipe.onUpiStatus(payload=>{if(payload?.kind==='success'){toast(`UPI paid${payload.orderRef?` · ${payload.orderRef}`:''}`);beep('ok');}else if(payload?.kind==='failed'){toast(`UPI failed: ${payload.reason||'unknown'}`,'err');beep('err');}});
(async()=>{state={...defaults,...await window.snipe.getState()};state.settings={...defaults.settings,...state.settings};state.accounts=state.accounts||[];state.cards=state.cards||[];state.orders=state.orders||[];render();updateConditionalFields();})();
