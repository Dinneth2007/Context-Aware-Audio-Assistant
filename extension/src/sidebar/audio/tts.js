// Browser-only TTS via window.speechSynthesis. Picks a reasonable
// English voice on init.

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

// Clear any leftover backend preference from the OpenAI-TTS era.
try { chrome?.storage?.local?.remove?.('wubble.voice'); } catch {}

export function speak(text) {
  return new Promise((resolve, reject) => {
    const t = (text || '').trim();
    if (!t) return resolve();
    if (!('speechSynthesis' in window)) return reject(new Error('speechSynthesis unavailable'));
    const utt = new SpeechSynthesisUtterance(t);
    if (pickedVoice) utt.voice = pickedVoice;
    utt.rate = 1.0;
    utt.pitch = 1.0;
    utt.onend = () => resolve();
    utt.onerror = (e) => {
      // 'interrupted'/'canceled' fires on cancel(); treat as resolved.
      if (e.error === 'interrupted' || e.error === 'canceled') return resolve();
      reject(new Error(`speechSynthesis: ${e.error || 'unknown'}`));
    };
    window.speechSynthesis.speak(utt);
  });
}

export function cancel() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function isSpeaking() {
  return 'speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
}
