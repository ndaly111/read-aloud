/* ==========  CONSTANTS  ========== */
const CHUNK = 900;                               // 900-char slices
const LANGS = { en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian' };
const $     = id => document.getElementById(id);

/* ==========  DOM refs  ========== */
const txt   = $('txt'),   langSel = $('lang'),   voiceSel = $('voice'),
      rateR = $('rate'),  rateV   = $('rv'),
      bar   = $('bar'),   ela     = $('ela'),    rem      = $('rem'),
      pct   = $('meter').firstElementChild,
      startB = $('start'), pauseB = $('pause'),  resumeB  = $('resume'), stopB = $('stop'),
      disp  = $('disp');

/* ==========  GLOBALS  ========== */
let voices=[], queue=[], utter=null, progChar=0, totalChars=0,
    startTime=0, boundarySeen=false, fallbackAud=null,
    keyRSS=null, isSpeaking=false;

/* ----------  meSpeak (offline fallback) ---------- */
window.mespeakLoaded = false;
mespeak.loadConfig('https://unpkg.com/mespeak/mespeak_config.json');
mespeak.loadVoice('https://unpkg.com/mespeak/voices/en/en.json',
                  () => window.mespeakLoaded = true);

/* ==========  INIT  ========== */
(async function init () {
  Object.entries(LANGS).forEach(([c,n]) => langSel.add(new Option(n,c)));
  langSel.value = (navigator.language || 'en').slice(0,2);       // pick user locale
  rateR.oninput = () => rateV.textContent = rateR.value;

  voiceSel.addEventListener('change', () => voiceSel.value !== '-1' && previewVoice());

  startB.onclick = startSpeak;
  pauseB.onclick = () => { speechSynthesis.pause();  fallbackAud?.pause(); };
  resumeB.onclick= () => { speechSynthesis.resume(); fallbackAud?.play();  };
  stopB.onclick  = stopAll;

  txt.addEventListener('input', buildDisplay);
  window.addEventListener('resize',  autoSize);

  try { keyRSS = (await fetch('api_key.json').then(r=>r.json())).VoiceRSS_API_Key; } catch {}

  /* ---------- load voices without blocking ---------- */
  loadVoices();          // don’t await → UI appears immediately
  buildDisplay(); autoSize();
})();

/* ==========  VOICE HANDLING  ========== */
function loadVoices(){
  const fill = () => {
    voices = speechSynthesis.getVoices();
    if (voices.length) populateVoiceSel();
  };
  fill();                                // first try
  speechSynthesis.onvoiceschanged = fill;/* Safari/iOS fires this later */

  /* Kick-start iOS: a silent utterance after a user gesture (Start click)
     will also populate the list if onvoiceschanged didn’t fire.           */
}
function populateVoiceSel(){
  const cur = voiceSel.value;
  voiceSel.innerHTML = '<option value="-1">Default</option>';
  voices.forEach((v,i)=>voiceSel.add(new Option(`${v.name} (${v.lang})`,i)));
  voiceSel.value = voices.some((_,i)=>String(i)===cur) ? cur : '-1';
}
function previewVoice(){
  const u = new SpeechSynthesisUtterance('Hi');
  if (voiceSel.value !== '-1') u.voice = voices[+voiceSel.value];
  u.rate = +rateR.value; speechSynthesis.speak(u);
}

/* ==========  DISPLAY BUILD  ========== */
function buildDisplay(){
  disp.innerHTML=''; totalChars = txt.value.length;
  txt.value.split(/(\s+)/).forEach(tok=>{
    const s=document.createElement('span'); s.textContent=tok; disp.appendChild(s);
  });
  resetMeter();
}

/* ==========  START SPEAK  ========== */
function startSpeak(){
  if (isSpeaking) stopAll();
  if (!txt.value.trim()){ alert('Type or paste some text'); return; }

  // 1. Try **native voices** if any exist (no need to pick one explicitly)
  if (speechSynthesis.getVoices().length){
    queue     = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK}}(?:\\s|$)`,'g')) || [];
    progChar  = 0; startTime = Date.now(); boundarySeen = false; isSpeaking = true;
    speakNext(); requestAnimationFrame(progressLoop);
    return;
  }

  // 2. Otherwise drop to fallback path
  fallbackSpeak();
}
function speakNext(){
  if (!queue.length){ finish(); return; }
  const chunk = queue.shift();
  utter       = new SpeechSynthesisUtterance(chunk);
  utter.rate  = +rateR.value;
  if (voiceSel.value !== '-1') utter.voice = voices[+voiceSel.value]; // user-chosen voice
  const chunkStart = progChar;
  utter.onboundary = e => { progChar = chunkStart + e.charIndex; boundarySeen = true; };
  utter.onend      = () => { progChar = chunkStart + chunk.length; speakNext(); };
  speechSynthesis.speak(utter);
}

/* ==========  PROGRESS & HIGHLIGHT  ========== */
function progressLoop(){
  if (!isSpeaking) return;
  if (!boundarySeen){                // fallback rough estimate before first boundary
    const elapsed = (Date.now()-startTime)/1000;
    progChar      = Math.min(totalChars, Math.round(elapsed * (180/60) * 5 ));
  }
  updateMeter(progChar); requestAnimationFrame(progressLoop);
}
function updateMeter(c){
  const p = totalChars ? Math.round(c/totalChars*100) : 0;
  bar.value=p; pct.textContent=p+' %';
  const el = Math.floor((Date.now()-startTime)/1000),
        estTotal = totalChars ? Math.round(totalChars/(180*5/60)/rateR.value) : 0,
        rm = Math.max(0, estTotal-el);
  ela.textContent = formatTime(el); rem.textContent = formatTime(rm); highlight(c);
}
function formatTime(s){
  const h=String(Math.floor(s/3600)).padStart(2,'0'),
        m=String(Math.floor(s%3600/60)).padStart(2,'0'),
        sc=String(s%60).padStart(2,'0');
  return `${h}:${m}:${sc}`;
}
function highlight(idx){
  let sum=0,target=null;
  for (const span of disp.childNodes){
    const len=span.textContent.length;
    if (idx>=sum && idx<sum+len){ target=span; break; }
    sum+=len;
  }
  Array.from(disp.children).forEach(s=>s.classList.remove('highlight'));
  if (target) target.classList.add('highlight');
}

/* ==========  FALLBACKS  ========== */
async function fallbackSpeak(){
  // a) offline JavaScript synth
  if (window.mespeakLoaded){
    progChar=0; startTime=Date.now(); isSpeaking=true;
    const chunks = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK}}(?:\\s|$)`,'g'))||[];
    for (const chunk of chunks){
      await new Promise(res=>mespeak.speak(chunk,{speed:+rateR.value*175},res));
      progChar+=chunk.length; updateMeter(progChar);
    }
    finish(); return;
  }
  // b) cloud (VoiceRSS) – only if you’ve provided an API key
  if (!keyRSS){ alert('No voices available on this device, and no fallback audio configured.'); return; }

  progChar=0; startTime=Date.now(); isSpeaking=true;
  const chunks = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK}}(?:\\s|$)`,'g'))||[];
  for (const chunk of chunks){ await playViaRSS(chunk); progChar+=chunk.length; }
  finish();
}
function playViaRSS(textPart){
  return new Promise(async res=>{
    const rVal = Math.round(((rateR.value-0.5)/1.5)*10-5);
    const url  = `https://api.voicerss.org/?key=${keyRSS}&hl=${langSel.value}`+
                 `&c=MP3&r=${rVal}&src=${encodeURIComponent(textPart)}`;
    const aud  = new Audio(url); fallbackAud = aud; aud.play();
    const len=textPart.length, base=progChar;
    const tID=setInterval(()=>updateMeter(base+Math.round(len*(aud.currentTime/aud.duration||0))),200);
    aud.onended = ()=>{ clearInterval(tID); res(); };
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden) aud.play(); });
  });
}

/* ==========  STOP / FINISH  ========== */
function stopAll(){
  speechSynthesis.cancel(); queue=[]; isSpeaking=false;
  fallbackAud?.pause(); fallbackAud=null; resetMeter();
}
function finish(){ isSpeaking=false; updateMeter(totalChars); }
function resetMeter(){
  bar.value=0; pct.textContent='0 %'; ela.textContent='00:00:00'; rem.textContent='00:00:00';
}
function autoSize(){ txt.style.height='auto'; txt.style.height=txt.scrollHeight+'px'; }
