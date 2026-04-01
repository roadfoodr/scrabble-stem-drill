import { DrillState } from './state.js';
import { GeminiDrill } from './gemini-drill.js';
import { OfflineFallback } from './offline-fallback.js';

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);

// --- State ---
let drillState = null;
let geminiDrill = null;
let offline = null;
let snapshot = null;
let mode = 'idle'; // 'idle' | 'gemini' | 'offline' | 'paused'

// --- Worker URL ---
const WORKER_URL =
  query.get('ws') ||
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

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
      showStatus('');
      clearHeardGuess();
      $('progressPill').textContent = '--';
      renderFoundWords();
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

function showStatus(text = '') {
  $('status').textContent = text;
}

function showHeardGuess(text = '') {
  const heardGuess = $('heardGuess');
  heardGuess.textContent = text ? `Heard: ${text}` : '';
  heardGuess.hidden = !text;
}

function clearHeardGuess() {
  showHeardGuess('');
}

function renderFoundWords() {
  const foundWords = $('foundWords');
  foundWords.textContent = '';

  if (!drillState?.current || drillState.current.found.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'found-empty';
    empty.textContent = 'No correct words yet.';
    foundWords.appendChild(empty);
    return;
  }

  for (const word of drillState.current.found) {
    const item = document.createElement('div');
    item.className = 'found-word';
    item.textContent = word;
    foundWords.appendChild(item);
  }
}

function refreshDrillUi() {
  showProgress();
  renderFoundWords();
}

function applyGeminiUiUpdate(update) {
  if (!update) {
    refreshDrillUi();
    return;
  }

  if (update.clearHeard) {
    clearHeardGuess();
  }

  if (update.statusText !== undefined) {
    clearHeardGuess();
    showStatus(update.statusText);
  }

  if (update.heardText !== undefined) {
    showHeardGuess(update.heardText);
  }

  refreshDrillUi();
}

function showProgress() {
  if (drillState?.current) {
    $('prompt').textContent = drillState.promptText;
    $('progressPill').textContent = `${drillState.foundCount} / ${drillState.current.targets.size} found`;
  } else {
    $('progressPill').textContent = '--';
  }
}

// --- Gemini mode ---
async function startGemini() {
  drillState = new DrillState();
  drillState.buildQueue();
  drillState.loadPrompt(0);

  geminiDrill = new GeminiDrill(drillState, WORKER_URL);
  geminiDrill.onUiUpdate = applyGeminiUiUpdate;
  geminiDrill.onFallbackToOffline = () => {
    clearHeardGuess();
    showStatus('Gemini disconnected. Switching to offline mode.');
    cleanupGemini();
    startOffline();
  };

  try {
    await geminiDrill.start();
    setMode('gemini');
    refreshDrillUi();
  } catch {
    cleanupGemini();
    startOffline();
  }
}

function cleanupGemini() {
  geminiDrill?.stop();
  geminiDrill = null;
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
    clearHeardGuess();
    showStatus(text);
    refreshDrillUi();
  };

  setMode('offline');
  refreshDrillUi();
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
  clearHeardGuess();
  showStatus('Paused. Tap Resume to continue.');
}

async function resume() {
  if (snapshot && !drillState) {
    drillState = new DrillState();
  }
  if (snapshot) {
    drillState.restore(snapshot);
  }
  refreshDrillUi();

  geminiDrill = new GeminiDrill(drillState, WORKER_URL);
  geminiDrill.onUiUpdate = applyGeminiUiUpdate;
  geminiDrill.onFallbackToOffline = () => {
    clearHeardGuess();
    showStatus('Disconnected. Switching to offline.');
    cleanupGemini();
    startOffline();
  };

  try {
    await geminiDrill.start();
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
      clearHeardGuess();
      showStatus('Connecting...');
      await startGemini();
      break;
    case 'gemini':
    case 'offline':
      pause();
      break;
    case 'paused':
      clearHeardGuess();
      showStatus('Reconnecting...');
      await resume();
      break;
  }
});

$('btnHint').addEventListener('click', () => {
  if (mode === 'gemini') {
    geminiDrill?.doHint();
  } else if (mode === 'offline') {
    offline?._doHint();
  }
});

$('btnSkip').addEventListener('click', () => {
  if (mode === 'gemini') {
    geminiDrill?.doSkip();
  } else if (mode === 'offline') {
    drillState.skip();
    clearHeardGuess();
    refreshDrillUi();
    offline._speak('Skipping. ' + offline._promptPhrase());
  }
});

// --- Init ---
updateUI();
renderFoundWords();
