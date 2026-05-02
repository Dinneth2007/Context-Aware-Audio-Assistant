// Unified TTS service. Two backends behind one interface:
//   - 'browser': window.speechSynthesis
//   - 'openai':  fetches /api/tts and plays audio/mpeg in an <audio> element
// Backend is persisted in chrome.storage.local under wubble.voice.

import { TTS_ENDPOINT } from '../../lib/api.js';

const STORAGE_KEY = 'wubble.voice';
let currentBackend = 'browser';
let backendReady = false;
const backendListeners = new Set();
const fallbackListeners = new Set();

let pickedVoice = null;
let voicesReady = false;

function pickEnglishVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang || '') || /english/i.test(v.name));
  if (!en.length) return voices[0];
  const preferred = en.find((v) => /Google/i.test(v.name) || /Natural/i.test(v.name));
  return preferred || en.find((v) => /en[-_]US/i.test(v.lang)) || en[0];
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  const refresh = () => {
    pickedVoice = pickEnglishVoice();
    voicesReady = !!pickedVoice;
  };
  refresh();
  window.speechSynthesis.addEventListener('voiceschanged', refresh);
}

(async function loadBackend() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored?.[STORAGE_KEY] === 'openai' || stored?.[STORAGE_KEY] === 'browser') {
      currentBackend = stored[STORAGE_KEY];
    }
  } catch {}
  backendReady = true;
  for (const fn of backendListeners) fn(currentBackend);
})();

export function getBackend() { return currentBackend; }
export function onBackendChange(fn) {
  backendListeners.add(fn);
  if (backendReady) fn(currentBackend);
  return () => backendListeners.delete(fn);
}
export async function setBackend(next) {
  if (next !== 'browser' && next !== 'openai') return;
  cancel();
  currentBackend = next;
  try { await chrome.storage.local.set({ [STORAGE_KEY]: next }); } catch {}
  for (const fn of backendListeners) fn(currentBackend);
}

export function onFallback(fn) {
  fallbackListeners.add(fn);
  return () => fallbackListeners.delete(fn);
}
function emitFallback(reason) {
  for (const fn of fallbackListeners) { try { fn(reason); } catch {} }
}

// ---------- Browser backend ----------
let browserCurrent = null; // { utterance, resolve, reject }

function browserSpeak(text) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) return reject(new Error('speechSynthesis unavailable'));
    const utt = new SpeechSynthesisUtterance(text);
    if (pickedVoice) utt.voice = pickedVoice;
    utt.rate = 1.0;
    utt.pitch = 1.0;
    utt.onend = () => { browserCurrent = null; resolve(); };
    utt.onerror = (e) => {
      browserCurrent = null;
      // 'interrupted'/'canceled' fires on cancel(); treat as resolved.
      if (e.error === 'interrupted' || e.error === 'canceled') return resolve();
      reject(new Error(`speechSynthesis: ${e.error || 'unknown'}`));
    };
    browserCurrent = { utterance: utt, resolve, reject };
    window.speechSynthesis.speak(utt);
  });
}

function browserCancel() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  browserCurrent = null;
}

function browserIsSpeaking() {
  return 'speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
}

// ---------- OpenAI backend ----------
const audioEl = typeof Audio !== 'undefined' ? new Audio() : null;
const ttsQueue = []; // { text, voice, resolve, reject, cancelled, controller }
let ttsProcessing = false;

async function fetchTTS(text, voice, signal) {
  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || 'alloy' }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`TTS ${res.status}: ${errText || res.statusText}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

function waitForEnded(audio) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onErr);
      audio.removeEventListener('pause', onPause);
    }
    function onEnd() { cleanup(); resolve(); }
    function onErr() { cleanup(); reject(new Error('audio playback failed')); }
    function onPause() {
      // Only resolve on pause when src has been cleared (cancel path).
      if (!audio.src) { cleanup(); resolve(); }
    }
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onErr);
    audio.addEventListener('pause', onPause);
  });
}

async function processTTSQueue() {
  if (ttsProcessing || !audioEl) return;
  ttsProcessing = true;
  while (ttsQueue.length) {
    const item = ttsQueue.shift();
    if (item.cancelled) { item.resolve(); continue; }
    let url = null;
    try {
      url = await fetchTTS(item.text, item.voice, item.controller.signal);
      if (item.cancelled) { URL.revokeObjectURL(url); item.resolve(); continue; }
      audioEl.src = url;
      await audioEl.play();
      await waitForEnded(audioEl);
      item.resolve();
    } catch (err) {
      if (item.cancelled || err?.name === 'AbortError') { item.resolve(); }
      else {
        emitFallback(err.message || 'premium voice failed');
        try { await browserSpeak(item.text); item.resolve(); }
        catch (e) { item.reject(e); }
      }
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  ttsProcessing = false;
}

function openaiSpeak(text, voice) {
  if (!audioEl) return Promise.reject(new Error('Audio element unavailable'));
  return new Promise((resolve, reject) => {
    const item = { text, voice, resolve, reject, cancelled: false, controller: new AbortController() };
    ttsQueue.push(item);
    processTTSQueue();
  });
}

function openaiCancel() {
  for (const item of ttsQueue) {
    item.cancelled = true;
    try { item.controller.abort(); } catch {}
  }
  ttsQueue.length = 0;
  if (audioEl) {
    try { audioEl.pause(); } catch {}
    audioEl.removeAttribute('src');
    audioEl.load();
  }
}

function openaiIsSpeaking() {
  if (!audioEl) return false;
  return ttsQueue.length > 0 || (!audioEl.paused && !audioEl.ended && !!audioEl.src);
}

// ---------- Public API ----------
export async function speak(text, opts = {}) {
  const t = (text || '').trim();
  if (!t) return;
  if (currentBackend === 'openai') return openaiSpeak(t, opts.voice);
  return browserSpeak(t);
}

export function cancel() {
  browserCancel();
  openaiCancel();
}

export function isSpeaking() {
  return browserIsSpeaking() || openaiIsSpeaking();
}
