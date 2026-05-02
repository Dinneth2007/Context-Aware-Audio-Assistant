// Extension TTS via chrome.tts (no user-gesture restrictions, works
// reliably in side panels). Falls back to window.speechSynthesis if
// chrome.tts isn't available.

let pickedVoice = null;

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
  const refresh = () => { pickedVoice = pickEnglishVoice(); };
  refresh();
  window.speechSynthesis.addEventListener('voiceschanged', refresh);
}

try { chrome?.storage?.local?.remove?.('wubble.voice'); } catch {}

function hasChromeTTS() {
  return typeof chrome !== 'undefined' && chrome.tts && typeof chrome.tts.speak === 'function';
}

function speakViaChromeTTS(text) {
  return new Promise((resolve, reject) => {
    chrome.tts.speak(text, {
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      lang: 'en-US',
      onEvent: (event) => {
        if (event.type === 'end') resolve();
        else if (event.type === 'cancelled' || event.type === 'interrupted') resolve();
        else if (event.type === 'error') reject(new Error(event.errorMessage || 'tts error'));
      },
    });
    // Surface enqueue-time errors via lastError.
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message || 'tts enqueue failed'));
    }
  });
}

function speakViaSynth(text) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) return reject(new Error('speechSynthesis unavailable'));
    try { window.speechSynthesis.resume(); } catch {}
    const utt = new SpeechSynthesisUtterance(text);
    if (pickedVoice) utt.voice = pickedVoice;
    utt.rate = 1.0;
    utt.pitch = 1.0;
    utt.onend = () => resolve();
    utt.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return resolve();
      reject(new Error(`speechSynthesis: ${e.error || 'unknown'}`));
    };
    window.speechSynthesis.speak(utt);
  });
}

export async function speak(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (hasChromeTTS()) {
    try {
      await speakViaChromeTTS(t);
      return;
    } catch (e) {
      console.warn('[wubble tts] chrome.tts failed, falling back to speechSynthesis:', e.message);
    }
  }
  await speakViaSynth(t);
}

export function cancel() {
  try { chrome?.tts?.stop?.(); } catch {}
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
}

export function isSpeaking() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) return true;
  }
  return false;
}
