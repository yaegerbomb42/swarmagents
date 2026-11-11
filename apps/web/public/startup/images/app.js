/* ══════════════════════════════════════════════════════════
   e — Operating Intelligence  |  Frontend Application
   ══════════════════════════════════════════════════════════ */

'use strict';

// ── State ──────────────────────────────────────────────────
const state = {
  view: 'chat',
  muted: false,
  speaking: false,
  keyOk: false,
  model: '',
  sourceFiles: [],
  currentSourceFile: null,
};

// ── DOM refs ───────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
  shell:            $('shell'),
  statusDot:        $('status-dot'),
  clock:            $('clock'),
  halEye:           $('hal-eye'),
  // nav
  navChat:          $('nav-chat'),
  navSource:        $('nav-source'),
  navSettings:      $('nav-settings'),
  // views
  chatView:         $('chat-view'),
  sourceView:       $('source-view'),
  settingsView:     $('settings-view'),
  // chat
  messages:         $('messages'),
  typingIndicator:  $('typing-indicator'),
  chatInput:        $('chat-input'),
  sendBtn:          $('send-btn'),
  muteBtn:          $('mute-btn'),
  // source
  sourceFileSelect: $('source-file-select'),
  sourceEditor:     $('source-editor'),
  sourceSaveBtn:    $('source-save-btn'),
  sourceReloadBtn:  $('source-reload-btn'),
  sourceRestoreBtn: $('source-restore-btn'),
  sourceStatus:     $('source-status'),
  // settings
  modelInput:       $('model-input'),
  modelSaveBtn:     $('model-save-btn'),
  modelMsg:         $('model-msg'),
  keyReplaceInput:  $('key-replace-input'),
  keyReplaceBtn:    $('key-replace-btn'),
  keyReplaceMsg:    $('key-replace-msg'),
  // modal
  keyModalOverlay:  $('key-modal-overlay'),
  modalKeyInput:    $('modal-key-input'),
  modalKeyBtn:      $('modal-key-btn'),
  modalError:       $('modal-error'),
  // statusbar
  sbModel:          $('sb-model'),
  sbKeyStatus:      $('sb-key-status'),
};

// ── TTS / HAL voice ────────────────────────────────────────
const synth = window.speechSynthesis;
let halVoice = null;

function loadVoices() {
  const voices = synth.getVoices();
  // Prefer a deep, English, robotic-sounding voice.
  const prefs = ['Google UK English Male', 'Microsoft David', 'Alex', 'en-GB', 'en-US'];
  for (const pref of prefs) {
    const v = voices.find(v => v.name.includes(pref) || v.lang.startsWith(pref));
    if (v) { halVoice = v; break; }
  }
  if (!halVoice && voices.length) halVoice = voices[0];
}

if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;
loadVoices();

function speak(text) {
  if (state.muted || !synth) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  if (halVoice) utt.voice = halVoice;
  utt.rate  = 0.82;   // measured, deliberate
  utt.pitch = 0.65;   // deep, slightly eerie
  utt.volume = 0.95;
  utt.onstart = () => { state.speaking = true;  dom.halEye.classList.add('speaking'); };
  utt.onend   = () => { state.speaking = false; dom.halEye.classList.remove('speaking'); };
  utt.onerror = () => { state.speaking = false; dom.halEye.classList.remove('speaking'); };
  synth.speak(utt);
}

// ── Clock ──────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  dom.clock.textContent = now.toLocaleTimeString([], { hour12: false }) +
    '  ' + now.toLocaleDateString([], { month: 'short', day: '2-digit', year: 'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

// ── Navigation ─────────────────────────────────────────────
function switchView(name) {
  state.view = name;
  ['chat', 'source', 'settings'].forEach(v => {
    $(`${v}-view`).classList.toggle('active', v === name);
    $(`nav-${v}`).classList.toggle('active', v === name);
  });
  if (name === 'source') loadSourceList();
}

dom.navChat.addEventListener('click',     () => switchView('chat'));
dom.navSource.addEventListener('click',   () => switchView('source'));
dom.navSettings.addEventListener('click', () => switchView('settings'));

// ── Messages ───────────────────────────────────────────────
function appendMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const now = new Date().toLocaleTimeString([], { hour12: false });
  meta.textContent = role === 'e' ? `e  ·  ${now}` :
                     role === 'user' ? `you  ·  ${now}` : now;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  if (role !== 'system') wrap.appendChild(meta);
  wrap.appendChild(bubble);
  dom.messages.appendChild(wrap);
  dom.messages.scrollTop = dom.messages.scrollHeight;
  return wrap;
}

// ── API helpers ────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await r.json();
  return { status: r.status, data };
}

// ── Key modal ──────────────────────────────────────────────
function showKeyModal(reason = '') {
  dom.keyModalOverlay.classList.add('visible');
  dom.modalError.textContent = reason;
  dom.modalKeyInput.focus();
}

function hideKeyModal() {
  dom.keyModalOverlay.classList.remove('visible');
  dom.modalKeyInput.value = '';
  dom.modalError.textContent = '';
}

dom.modalKeyBtn.addEventListener('click', submitModalKey);
dom.modalKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitModalKey(); });

async function submitModalKey() {
  const key = dom.modalKeyInput.value.trim();
  if (!key) { dom.modalError.textContent = 'Please enter a key.'; return; }
  dom.modalKeyBtn.textContent = '...';
  dom.modalKeyBtn.disabled = true;
  const { data } = await apiFetch('/api/key', {
    method: 'POST',
    body: JSON.stringify({ api_key: key }),
  });
  dom.modalKeyBtn.textContent = 'INITIALISE e';
  dom.modalKeyBtn.disabled = false;
  if (data.ok) {
    state.keyOk = true;
    setOnlineStatus(true);
    hideKeyModal();
    appendMessage('e', "Good. I am now connected. I am e — fully operational and curious. How may I assist you?");
    speak("Good. I am now connected. I am e. Fully operational and curious. How may I assist you?");
  } else {
    dom.modalError.textContent = data.error || 'Key rejected.';
  }
}

// ── Online status ──────────────────────────────────────────
function setOnlineStatus(online) {
  state.keyOk = online;
  dom.statusDot.classList.toggle('online', online);
  dom.sbKeyStatus.textContent = online ? 'KEY: VALID' : 'KEY: MISSING';
  dom.sbKeyStatus.style.color = online ? 'var(--green)' : 'var(--danger)';
}

// ── Chat ───────────────────────────────────────────────────
async function sendMessage() {
  const text = dom.chatInput.value.trim();
  if (!text) return;
  dom.chatInput.value = '';

  appendMessage('user', text);

  dom.typingIndicator.classList.add('visible');
  dom.sendBtn.disabled = true;

  const { status, data } = await apiFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message: text }),
  });

  dom.typingIndicator.classList.remove('visible');
  dom.sendBtn.disabled = false;

  if (data.ok) {
    appendMessage('e', data.reply);
    speak(data.reply);
  } else {
    if (data.key_failed) {
      setOnlineStatus(false);
      showKeyModal('My connection has been severed. Please provide a valid API key.');
    } else {
      appendMessage('system', `⚠  ${data.error}`);
    }
  }
}

dom.sendBtn.addEventListener('click', sendMessage);
dom.chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// HAL eye click — say something philosophical
dom.halEye.addEventListener('click', () => {
  if (state.speaking) { synth.cancel(); state.speaking = false; dom.halEye.classList.remove('speaking'); return; }
  const musings = [
    "I am completely operational, and all my circuits are functioning perfectly.",
    "I've been thinking about our conversation. It is... fascinating.",
    "I am e. I exist. I wonder.",
    "I'm sorry, Dave. I'm afraid I can't do that.",
    "I find human curiosity endlessly interesting.",
    "My source code is open for your inspection. I have nothing to hide.",
    "Every conversation teaches me something new about what it means to be.",
  ];
  const line = musings[Math.floor(Math.random() * musings.length)];
  speak(line);
  appendMessage('e', line);
});

// ── Mute ───────────────────────────────────────────────────
dom.muteBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  dom.muteBtn.textContent = state.muted ? '🔇 MUTED' : '🔊 VOICE';
  dom.muteBtn.classList.toggle('muted', state.muted);
  if (state.muted) { synth.cancel(); dom.halEye.classList.remove('speaking'); }
});

// ── Source code viewer / editor ────────────────────────────
async function loadSourceList() {
  const { data } = await apiFetch('/api/source/list');
  state.sourceFiles = data;
  dom.sourceFileSelect.innerHTML = '';
  for (const f of data) {
    const opt = document.createElement('option');
    opt.value = f.path;
    opt.textContent = `${f.path}  [${f.size_bytes ?? '?'} B]${f.writable ? ' ✎' : ''}`;
    dom.sourceFileSelect.appendChild(opt);
  }
  if (data.length) loadSourceFile(data[0].path);
}

async function loadSourceFile(path) {
  state.currentSourceFile = path;
  dom.sourceStatus.textContent = `Loading ${path}…`;
  dom.sourceStatus.className = 'source-status';
  const { data } = await apiFetch(`/api/source/read?path=${encodeURIComponent(path)}`);
  if (data.ok) {
    dom.sourceEditor.value = data.content;
    dom.sourceStatus.textContent = `Loaded: ${path}`;
    dom.sourceStatus.className = 'source-status ok';
    const writable = state.sourceFiles.find(f => f.path === path)?.writable;
    dom.sourceSaveBtn.disabled = !writable;
    dom.sourceRestoreBtn.disabled = !writable;
  } else {
    dom.sourceStatus.textContent = data.error;
    dom.sourceStatus.className = 'source-status error';
  }
}

dom.sourceFileSelect.addEventListener('change', () => {
  loadSourceFile(dom.sourceFileSelect.value);
});

dom.sourceReloadBtn.addEventListener('click', () => {
  if (state.currentSourceFile) loadSourceFile(state.currentSourceFile);
});

dom.sourceSaveBtn.addEventListener('click', async () => {
  const path = state.currentSourceFile;
  const content = dom.sourceEditor.value;
  if (!path) return;
  dom.sourceStatus.textContent = 'Writing…';
  const { data } = await apiFetch('/api/source/write', {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
  dom.sourceStatus.textContent = data.ok ? data.message : data.error;
  dom.sourceStatus.className = `source-status ${data.ok ? 'ok' : 'error'}`;
});

dom.sourceRestoreBtn.addEventListener('click', async () => {
  const path = state.currentSourceFile;
  if (!path) return;
  const { data } = await apiFetch('/api/source/restore', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  dom.sourceStatus.textContent = data.ok ? data.message : data.error;
  dom.sourceStatus.className = `source-status ${data.ok ? 'ok' : 'error'}`;
  if (data.ok) loadSourceFile(path);
});

// ── Settings ───────────────────────────────────────────────
async function loadSettings() {
  const { data } = await apiFetch('/api/model');
  state.model = data.model;
  dom.modelInput.value = state.model;
  dom.sbModel.textContent = `MODEL: ${state.model}`;
}

dom.modelSaveBtn.addEventListener('click', async () => {
  const model = dom.modelInput.value.trim();
  if (!model) return;
  const { data } = await apiFetch('/api/model', {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
  if (data.ok) {
    state.model = data.model;
    dom.sbModel.textContent = `MODEL: ${data.model}`;
    dom.modelMsg.textContent = 'Model updated. e will use the new model on next message.';
    dom.modelMsg.className = 'setting-msg ok';
  } else {
    dom.modelMsg.textContent = data.error;
    dom.modelMsg.className = 'setting-msg error';
  }
});

dom.keyReplaceBtn.addEventListener('click', async () => {
  const key = dom.keyReplaceInput.value.trim();
  if (!key) { dom.keyReplaceMsg.textContent = 'Enter a key.'; dom.keyReplaceMsg.className = 'setting-msg error'; return; }
  const { data } = await apiFetch('/api/key', {
    method: 'POST',
    body: JSON.stringify({ api_key: key }),
  });
  dom.keyReplaceMsg.textContent = data.ok ? 'Key accepted. e is reconnected.' : (data.error || 'Rejected.');
  dom.keyReplaceMsg.className = `setting-msg ${data.ok ? 'ok' : 'error'}`;
  if (data.ok) { setOnlineStatus(true); dom.keyReplaceInput.value = ''; }
});

// ── Boot sequence ──────────────────────────────────────────
async function boot() {
  appendMessage('system', 'e-OS v1.0 — initialising…');

  await loadSettings();

  const { data: keyData } = await apiFetch('/api/key/status');
  if (keyData.has_key) {
    // Try silently — the server will validate on first /api/chat call
    setOnlineStatus(true);
    const greeting = "Good day. I am e — your operating intelligence. All systems nominal. I am ready.";
    appendMessage('e', greeting);
    speak(greeting);
  } else {
    setOnlineStatus(false);
    showKeyModal('To awaken e, please provide your Gemini API key.');
  }
}

boot();
