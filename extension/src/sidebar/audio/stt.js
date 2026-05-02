// Wrapper around (webkit)SpeechRecognition with an event-emitter shape.
// Events: 'interim', 'final', 'error', 'end'.

const Recognition =
  (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;

const ERROR_MESSAGES = {
  'no-speech': "Didn't catch that — try speaking again.",
  'audio-capture': 'No microphone detected.',
  'not-allowed': 'Microphone permission denied. Click the lock icon in the address bar to allow it.',
  'service-not-allowed': 'Speech recognition is blocked in this context.',
  network: 'Speech recognition needs a network connection.',
  aborted: null, // user-initiated, no UI noise
};

export function isSTTAvailable() { return !!Recognition; }

export function createSTT() {
  if (!Recognition) {
    const errorListeners = new Set();
    return {
      start() {
        setTimeout(() => {
          for (const fn of errorListeners) {
            try { fn({ code: 'unsupported', message: 'Speech recognition not supported in this browser.' }); } catch {}
          }
        }, 0);
      },
      stop() {},
      on(event, cb) {
        if (event === 'error') {
          errorListeners.add(cb);
          return () => errorListeners.delete(cb);
        }
        return () => {};
      },
    };
  }

  const rec = new Recognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = 'en-US';

  const SILENCE_MS = 1000; // stop manually if no new interim within this window
  const listeners = { interim: new Set(), final: new Set(), error: new Set(), end: new Set() };
  let running = false;
  let lastInterim = '';
  let gotFinal = false;
  let silenceTimer = null;

  function emit(event, payload) {
    for (const fn of listeners[event] || []) {
      try { fn(payload); } catch (e) { console.error('[wubble stt] listener error:', e); }
    }
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      console.log('[wubble stt] silence timer fired, stopping. lastInterim:', lastInterim);
      try { rec.stop(); } catch {}
    }, SILENCE_MS);
  }

  rec.onresult = (ev) => {
    let interim = '';
    let finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) {
      lastInterim = interim.trim();
      emit('interim', lastInterim);
      resetSilenceTimer();
    }
    if (finalText) {
      gotFinal = true;
      lastInterim = '';
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      emit('final', finalText.trim());
    }
  };

  rec.onerror = (ev) => {
    const code = ev.error || 'unknown';
    const message = ERROR_MESSAGES[code];
    if (message === null) return; // suppressed (e.g. user-aborted)
    emit('error', { code, message: message || `Speech recognition error: ${code}` });
  };

  rec.onend = () => {
    console.log('[wubble stt] onend, gotFinal:', gotFinal, 'lastInterim:', lastInterim);
    running = false;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (lastInterim && lastInterim.trim()) {
      const t = lastInterim.trim();
      lastInterim = '';
      console.log('[wubble stt] promoting interim to final:', t);
      emit('final', t);
    }
    emit('end');
  };
  rec.onstart = () => {
    console.log('[wubble stt] onstart');
    running = true;
    lastInterim = '';
    gotFinal = false;
  };

  return {
    start() {
      if (running) return;
      try { rec.start(); }
      catch (err) { emit('error', { code: 'start-failed', message: err.message }); }
    },
    stop() {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (!running) return;
      try { rec.stop(); } catch {}
    },
    on(event, cb) {
      if (!listeners[event]) return () => {};
      listeners[event].add(cb);
      return () => listeners[event].delete(cb);
    },
  };
}
