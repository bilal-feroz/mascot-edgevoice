// api/chat.js
// Frontend logic + Vercel edge function call (Groq). Voice turn-taking with barge-in and delays.

const API_BASE = ''; // same origin
const $ = (s)=>document.querySelector(s);
const log = $("#log");
const input = $("#input");
const sendBtn = $("#send");
const toggleVoiceBtn = $("#toggleVoice");
const speakSwitch = $("#speakSwitch");
const rateEl = $("#rate");
const stateBadge = $("#stateBadge");

// ---- Chat state -------------------------------------------------------------
const history = [];
let inFlight = false;          // request gate (avoid 429/dup)
let lastSendAt = 0;            // min spacing between API calls
const MIN_SEND_SPACING_MS = 1100;

const STATE = { IDLE: 'Idle', LISTEN: 'Listening', THINK: 'Thinking', SPEAK: 'Speaking', WAIT: 'Waiting', INTERRUPTED:'Interrupted → Listening' };
let state = STATE.IDLE;
let interrupted = false;

// ---- UI helpers -------------------------------------------------------------
function badge(cls, text){
  stateBadge.className = `badge ${cls||''}`; stateBadge.textContent = text;
}
function setState(s){
  state = s;
  if (s === STATE.LISTEN) badge('ok', 'Listening');
  else if (s === STATE.THINK) badge('', 'Thinking…');
  else if (s === STATE.SPEAK) badge('speaking', 'Speaking…');
  else if (s === STATE.WAIT) badge('', 'Waiting…');
  else if (s === STATE.INTERRUPTED) badge('interrupt', 'Interrupted → Listening');
  else badge('', 'Idle');
}
function push(role, text){
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

// ---- Word limiter -----------------------------------------------------------
function limitWords(s, n = 100) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length > n ? words.slice(0, n).join(" ") + "…" : s;
}

// ---- Vercel edge function caller -------------------------------------------
async function postJSON(url, payload){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function sendText(text){
  if (!text) return;
  const now = Date.now();
  if (inFlight || (now - lastSendAt) < MIN_SEND_SPACING_MS) return; // simple backoff
  inFlight = true; lastSendAt = now;

  history.push({role:'user', content:text});
  push('user', text);
  setState(STATE.THINK);

  try{
    const res = await postJSON('/api/chat', {messages: history});
    const raw = res.reply || '[no reply]';
    const reply = limitWords(raw, 100);
    history.push({role:'assistant', content: reply});
    push('assistant', reply);

    if (speakSwitch.checked) await speak(reply);         // async, returns after TTS ends or is cancelled
    // Wait 5s before reopening mic unless interrupted immediately
    if (!interrupted && voice.enabled){
      setState(STATE.WAIT);
      await wait(5000);
      if (!speechSynthesis.speaking) voice.start();      // reopen listening
    }
  }catch(e){
    console.error(e);
    push('assistant', `[error]`);
  }finally{
    inFlight = false;
    if (state === STATE.THINK) setState(STATE.IDLE);
  }
}

// ---- Keyboard & button ------------------------------------------------------
sendBtn.onclick = ()=> {
  const text = input.value.trim();
  input.value = '';
  sendText(text);
};
input.addEventListener('keydown', (ev)=>{
  if (ev.key === 'Enter' && !ev.shiftKey){
    ev.preventDefault();
    sendBtn.click();
  }
});
document.addEventListener('keydown', (ev)=>{
  if (ev.key.toLowerCase() === 'm') toggleVoiceBtn.click();
});

// ---- Speech Synthesis (Emily preferred) ------------------------------------
let selectedVoice = null;
function pickVoice(){
  const voices = speechSynthesis.getVoices() || [];
  // Prefer Microsoft Emily Online / Neural variants
  selectedVoice = voices.find(v => /emily/i.test(v.name) && /microsoft/i.test(v.name)) ||
                  voices.find(v => /neural/i.test(v.name) && /microsoft/i.test(v.name)) ||
                  voices.find(v => /english/i.test(v.lang)) || voices[0] || null;
}
speechSynthesis.onvoiceschanged = pickVoice; pickVoice();

function speak(text){
  return new Promise((resolve)=>{
    if (!text) return resolve();
    try{
      interrupted = false;
      const u = new SpeechSynthesisUtterance(text);
      if (selectedVoice) u.voice = selectedVoice;
      u.rate = parseFloat(rateEl.value || '1.0');
      u.onstart = ()=> setState(STATE.SPEAK);
      u.onend = ()=> { if(!interrupted) setState(STATE.IDLE); resolve(); };
      u.onerror = ()=> { if(!interrupted) setState(STATE.IDLE); resolve(); };
      speechSynthesis.speak(u);
    }catch{
      resolve();
    }
  });
}
function cancelTTS(){
  if (speechSynthesis.speaking){
    interrupted = true;
    speechSynthesis.cancel();
    setState(STATE.INTERRUPTED);
  }
}

// ---- Voice activity detection (for barge-in while speaking) -----------------
const voice = {
  enabled: false,
  rec: null,
  ctx: null, analyser: null, data: null, raf: 0,
  lastFinal: '', // dedupe last transcript
  start: async function(){
    if (this.enabled) return;
    // STT instance (Web Speech API)
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('This browser does not support SpeechRecognition'); return; }
    this.enabled = true;
    setState(STATE.LISTEN);
    this.rec = new SR();
    this.rec.lang = 'en-US';
    this.rec.interimResults = false;  // only final lines
    this.rec.continuous = false;      // one utterance→end

    this.rec.onresult = async (e)=>{
      const text = (e.results[0][0].transcript || '').trim();
      if (!text || text === this.lastFinal) return;
      this.lastFinal = text;
      setState(STATE.THINK);
      // Small safety spacing to avoid 429 bursts
      await wait(350);
      sendText(text);
    };
    this.rec.onend = ()=>{
      // Do not auto-reopen immediately; state machine decides when
      if (this.enabled && state === STATE.LISTEN){
        // slight debounce reopen to catch lingering noise
        setTimeout(()=> { try{ this.rec.start(); }catch{} }, 250);
      }
    };
    this.rec.onerror = (e)=> console.warn('SR error', e);

    // Kick recognition
    try{ this.rec.start(); }catch{}

    // Mic VAD stream for barge-in while speaking
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      const tick = ()=>{
        if (!this.enabled) return;
        this.analyser.getByteTimeDomainData(this.data);
        let sum = 0;
        for(let i=0;i<this.data.length;i++){
          const v = (this.data[i] - 128)/128; sum += v*v;
        }
        const rms = Math.sqrt(sum/this.data.length);
        // If user talks while TTS speaking -> interrupt
        if (speechSynthesis.speaking && rms > 0.06){ // adjust if needed
          cancelTTS();
          // give 600ms to let TTS buffer clear, then start SR
          setTimeout(()=> { try{ this.rec.start(); }catch{} }, 600);
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }catch(err){
      console.warn('VAD stream error', err);
    }
    toggleVoiceBtn.textContent = 'Voice On';
  },
  stop: function(){
    this.enabled = false;
    try{ this.rec && this.rec.stop(); }catch{}
    if (this.ctx){ try{ this.ctx.close(); }catch{} this.ctx = null; }
    if (this.raf) cancelAnimationFrame(this.raf);
    setState(STATE.IDLE);
    toggleVoiceBtn.textContent = 'Start Voice';
  }
};

toggleVoiceBtn.onclick = ()=> voice.enabled ? voice.stop() : voice.start();

// ---- Helpers ----------------------------------------------------------------
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

// If the user types while it’s speaking, barge-in:
input.addEventListener('focus', cancelTTS);

// Toggle mic by keyboard
// (global key handler already attached above)

// -----------------------------------------------------------------------------
// OPTIONAL: small auto-greeting in the log (no API call)
push('assistant', 'Voice is optional. Press “Start Voice” or type a message.');

// Expose send for manual typing
window.__edge_send = sendText;
