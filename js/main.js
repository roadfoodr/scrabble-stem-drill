import { DrillState } from './state.js';
import { GeminiSession } from './gemini-session.js';
import { AudioCapture } from './audio-capture.js';
import { AudioPlayback } from './audio-playback.js';
import { OfflineFallback } from './offline-fallback.js';
import { buildSystemPrompt } from './system-prompt.js';

const $ = (id) => document.getElementById(id);

// --- State ---
let drillState = null;
let gemini = null;
let capture = null;
let playback = null;
let offline = null;
let snapshot = null;
let mode = 'idle'; // 'idle' | 'gemini' | 'offline' | 'paused'

// --- Worker URL ---
// Resolve relative to current origin (Pages Function at /ws)
const WORKER_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

// --- UI helpers ---
function setMode(m) {
  mode = m;
  updateUI();
}

function updateUI() {
  const btnPrimary = $('btnPrimary');
  const btnHint = $('btnHint');
  const btnSkip = $('btnSkip');

  switch (mode) {
    case 'idle':
      btnPrimary.textContent = 'Start';
      btnPrimary.className = 'good';
      btnHint.disabled = true;
      btnSkip.disabled = true;
      $('connPill').textContent = 'Mode: --';
      $('connPill').className = 'pill';
      $('prompt').textContent = 'Tap Start';
      $('status').textContent = '';
      $('progressPill').textContent = '--';
      break;
    case 'gemini':
      btnPrimary.textContent = 'Pause';
      btnPrimary.className = 'danger';
      btnHint.disabled = false;
      btnSkip.disabled = false;
      $('connPill').textContent = 'Mode: Gemini';
      $('connPill').className = 'pill conn-gemini';
      break;
    case 'offline':
      btnPrimary.textContent = 'Pause';
      btnPrimary.className = 'danger';
      btnHint.disabled = false;
      btnSkip.disabled = false;
      $('connPill').textContent = 'Mode: Offline';
      $('connPill').className = 'pill conn-offline';
      break;
    case 'paused':
      btnPrimary.textContent = 'Resume';
      btnPrimary.className = 'good';
      btnHint.disabled = true;
      btnSkip.disabled = true;
      $('connPill').textContent = 'Mode: Paused';
      $('connPill').className = 'pill';
      break;
  }
}

function showStatus(text) {
  $('status').textContent = text;
}

function showProgress() {
  if (drillState?.current) {
    $('prompt').textContent = drillState.promptText;
    $('progressPill').textContent = `${drillState.foundCount} / ${drillState.current.targets.size} found`;
  }
}

// --- Gemini mode ---
async function startGemini() {
  drillState = new DrillState();
  drillState.buildQueue();
  drillState.loadPrompt(0);

  gemini = new GeminiSession(WORKER_URL);
  capture = new AudioCapture();
  playback = new AudioPlayback();

  gemini.onAudio = (base64) => {
    if (base64 === '') {
      playback.flush(); // interruption
    } else {
      playback.enqueue(base64);
    }
  };

  gemini.onText = (text) => {
    showStatus(text);
  };

  gemini.onToolCall = (name, args) => {
    if (name === 'mark_word_found' && drillState) {
      drillState.markFound(args.word);
      showProgress();
    } else if (name === 'advance_prompt' && drillState) {
      drillState.loadPrompt(args.promptIndex - 1);
      showProgress();
    }
  };

  gemini.onError = (err) => {
    showStatus(`Connection error: ${err.message}`);
  };

  gemini.onDisconnect = () => {
    if (mode === 'gemini') {
      showStatus('Gemini disconnected. Switching to offline mode.');
      cleanupGemini();
      startOffline();
    }
  };

  try {
    const prompt = buildSystemPrompt(drillState);
    await gemini.connect(prompt);
  } catch {
    showStatus('Could not connect to Gemini. Starting offline mode.');
    cleanupGemini();
    startOffline();
    return;
  }

  try {
    await capture.start();
  } catch (e) {
    showStatus(`Mic error: ${e.message}. Starting offline mode.`);
    cleanupGemini();
    startOffline();
    return;
  }

  capture.onChunk = (base64) => {
    gemini.sendAudio(base64);
  };

  setMode('gemini');
  showProgress();
}

function cleanupGemini() {
  capture?.stop();
  capture = null;
  playback?.close();
  playback = null;
  gemini?.disconnect();
  gemini = null;
}

// --- Offline mode ---
function startOffline() {
  if (!drillState) {
    drillState = new DrillState();
    drillState.buildQueue();
    drillState.loadPrompt(0);
  }

  offline = new OfflineFallback(drillState);
  offline.onStatusUpdate = (text) => {
    showStatus(text);
    showProgress();
  };

  setMode('offline');
  showProgress();
  offline.start();
}

function cleanupOffline() {
  offline?.stop();
  offline = null;
}

// --- Pause / Resume ---
function pause() {
  snapshot = drillState?.serialize() || null;
  if (mode === 'gemini') {
    cleanupGemini();
  } else if (mode === 'offline') {
    cleanupOffline();
  }
  setMode('paused');
  showStatus('Paused. Tap Resume to continue.');
}

async function resume() {
  if (snapshot && !drillState) {
    drillState = new DrillState();
  }
  if (snapshot) {
    drillState.restore(snapshot);
  }
  showProgress();

  // Try Gemini first, fall back to offline
  gemini = new GeminiSession(WORKER_URL);
  capture = new AudioCapture();
  playback = new AudioPlayback();

  gemini.onAudio = (base64) => {
    if (base64 === '') playback.flush();
    else playback.enqueue(base64);
  };
  gemini.onText = (text) => showStatus(text);
  gemini.onToolCall = (name, args) => {
    if (name === 'mark_word_found' && drillState) {
      drillState.markFound(args.word);
      showProgress();
    } else if (name === 'advance_prompt' && drillState) {
      drillState.loadPrompt(args.promptIndex - 1);
      showProgress();
    }
  };
  gemini.onError = (err) => showStatus(`Error: ${err.message}`);
  gemini.onDisconnect = () => {
    if (mode === 'gemini') {
      showStatus('Disconnected. Switching to offline.');
      cleanupGemini();
      startOffline();
    }
  };

  try {
    const prompt = buildSystemPrompt(drillState);
    await gemini.connect(prompt);
    await capture.start();
    capture.onChunk = (base64) => gemini.sendAudio(base64);
    setMode('gemini');
  } catch {
    cleanupGemini();
    startOffline();
  }
}

// --- Button handlers ---
$('btnPrimary').addEventListener('click', async () => {
  switch (mode) {
    case 'idle':
      showStatus('Connecting...');
      await startGemini();
      break;
    case 'gemini':
    case 'offline':
      pause();
      break;
    case 'paused':
      showStatus('Reconnecting...');
      await resume();
      break;
  }
});

$('btnHint').addEventListener('click', () => {
  if (mode === 'gemini' && gemini?.connected) {
    gemini.sendText('hint');
  } else if (mode === 'offline' && offline) {
    offline._doHint();
  }
});

$('btnSkip').addEventListener('click', () => {
  if (mode === 'gemini' && gemini?.connected) {
    gemini.sendText('skip');
  } else if (mode === 'offline' && offline) {
    drillState.skip();
    showProgress();
    offline._speak('Skipping. ' + offline._promptPhrase());
  }
});

// --- Init ---
updateUI();
