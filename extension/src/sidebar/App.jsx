import { useEffect, useRef, useState, useCallback } from 'react';
import { askAboutPage, streamAsk } from '../lib/api.js';
import { buildContextPayload } from '../lib/context.js';
import * as tts from './audio/tts.js';
import { createSTT, isSTTAvailable } from './audio/stt.js';
import {
  useAudioState,
  bindSTT,
  bindAbortController,
  clearAbortController,
  getState as getAudioState,
} from './audio/state.js';

const PROACTIVE_AUTO_DISMISS_MS = 12000;
const CUE_STORAGE_KEY = 'wubble.proactiveAudioCue';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function fetchFocusFromTab(tabId) {
  return chrome.tabs
    .sendMessage(tabId, { type: 'GET_FOCUS' })
    .catch(() => ({ ok: false, error: 'content script unreachable — refresh the page' }));
}

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  try { chrome.tabs.sendMessage(tabId, msg).catch(() => {}); } catch {}
}

function playAudioCue() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => { ctx.close().catch(() => {}); }, 280);
  } catch {}
}

function FocusPill({ focus }) {
  if (!focus) {
    return (
      <div className="text-xs text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-3 py-1 inline-block">
        Waiting for page focus…
      </div>
    );
  }
  if (focus.pageMeta?.restricted) {
    return (
      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-3 py-1 inline-block">
        ⚠ {focus.pageMeta.restrictedReason || 'Restricted page'}
      </div>
    );
  }
  const heading = focus.section?.heading || '(no section detected)';
  const source = focus.source || 'viewport';
  return (
    <div className="text-xs text-slate-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1 inline-block truncate max-w-full">
      🎯 Focused on: <span className="font-medium">{heading}</span>{' '}
      <span className="text-slate-500">({source})</span>
    </div>
  );
}

function StateIndicator({ state }) {
  const meta = {
    idle:      { dot: 'bg-slate-300',  label: 'Idle' },
    listening: { dot: 'bg-rose-500 animate-pulse',   label: 'Listening…' },
    thinking:  { dot: 'bg-amber-500 animate-pulse',  label: 'Thinking…' },
    speaking:  { dot: 'bg-emerald-500 animate-pulse', label: 'Speaking…' },
  }[state];
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <span className={`inline-block w-2 h-2 rounded-full ${meta.dot}`} />
      <span>{meta.label}</span>
    </div>
  );
}

function ProactiveOffer({ heading, onAccept, onDismiss }) {
  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded p-3 text-sm flex items-start justify-between gap-3">
      <div className="flex-1">
        <div className="text-xs text-indigo-700 font-medium mb-1">Spotted you reading…</div>
        <div className="text-slate-800">
          Been here a while — want me to explain
          {' '}<span className="font-medium">"{heading}"</span>?
        </div>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onAccept}
            className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 transition"
          >
            Yes, explain
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs px-2 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 transition"
          >
            Dismiss
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className="text-slate-400 hover:text-slate-700 leading-none text-lg"
      >
        ×
      </button>
    </div>
  );
}

function flushSentences(buffer, sink) {
  const re = /[.!?]+[)"'\]]?\s+/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(buffer))) {
    const end = m.index + m[0].length;
    const sentence = buffer.slice(lastIndex, end).trim();
    if (sentence) sink(sentence);
    lastIndex = end;
  }
  return buffer.slice(lastIndex);
}

export default function App() {
  const [question, setQuestion] = useState('');
  const [interim, setInterim] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState(null);
  const [activeTabId, setActiveTabId] = useState(null);
  const [proactive, setProactive] = useState(null); // { sectionId, heading }
  const [audioCueEnabled, setAudioCueEnabled] = useState(true);

  const { state: audioState, transition } = useAudioState();
  const sttRef = useRef(null);
  const focusDebounce = useRef(null);
  const speakerSpeakingRef = useRef(false);
  const interimRef = useRef('');
  const runAskRef = useRef(null);
  const proactiveAutoDismissRef = useRef(null);
  const activeTabIdRef = useRef(null);

  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await chrome.storage.local.get(CUE_STORAGE_KEY);
        if (!cancelled && typeof stored?.[CUE_STORAGE_KEY] === 'boolean') {
          setAudioCueEnabled(stored[CUE_STORAGE_KEY]);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tab = await getActiveTab();
      if (cancelled || !tab) return;
      setActiveTabId(tab.id);
      const r = await fetchFocusFromTab(tab.id);
      if (!cancelled && r?.ok && r.focus) setFocus(r.focus);
    })();
    return () => { cancelled = true; };
  }, []);

  const dismissProactive = useCallback((reason) => {
    setProactive((cur) => {
      if (!cur) return null;
      if (reason !== 'accept') {
        // Tell content to mark this section dismissed for the page session.
        sendToTab(activeTabIdRef.current, { type: 'PROACTIVE_DISMISS', sectionId: cur.sectionId });
      }
      return null;
    });
    if (proactiveAutoDismissRef.current) {
      clearTimeout(proactiveAutoDismissRef.current);
      proactiveAutoDismissRef.current = null;
    }
  }, []);

  useEffect(() => {
    function onMsg(msg, sender) {
      if (!msg || typeof msg !== 'object') return;
      const fromActive = activeTabIdRef.current == null || sender?.tab?.id === activeTabIdRef.current;

      if (msg.type === 'FOCUS_CHANGE' && fromActive) {
        if (focusDebounce.current) clearTimeout(focusDebounce.current);
        focusDebounce.current = setTimeout(() => setFocus(msg.focus), 500);
        return;
      }

      if (msg.type === 'proactive-offer' && fromActive) {
        // Suppress entirely while audio loop is active; section stays
        // marked-fired in the content script (won't re-trigger this session).
        if (getAudioState() !== 'idle') return;
        if (!msg.sectionId) return;
        setProactive({ sectionId: msg.sectionId, heading: msg.heading || '(this section)' });
        if (audioCueEnabled) playAudioCue();
        if (proactiveAutoDismissRef.current) clearTimeout(proactiveAutoDismissRef.current);
        proactiveAutoDismissRef.current = setTimeout(() => {
          dismissProactive('auto');
        }, PROACTIVE_AUTO_DISMISS_MS);
      }
    }
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      if (focusDebounce.current) clearTimeout(focusDebounce.current);
    };
  }, [audioCueEnabled, dismissProactive]);

  useEffect(() => {
    function onActivated({ tabId }) {
      setActiveTabId(tabId);
      // Drop any pending offer when the user switches tabs.
      dismissProactive('tab-switch');
      fetchFocusFromTab(tabId).then((r) => { if (r?.ok && r.focus) setFocus(r.focus); });
    }
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, [dismissProactive]);

  useEffect(() => {
    if (!isSTTAvailable()) return;
    const stt = createSTT();
    sttRef.current = stt;
    bindSTT(stt);

    function submitTranscript(t) {
      interimRef.current = '';
      setInterim('');
      setQuestion(t);
      if (getAudioState() === 'listening') transition('thinking');
      const fn = runAskRef.current;
      if (fn) fn(t, { audio: true });
    }

    const offInterim = stt.on('interim', (t) => {
      interimRef.current = t;
      setInterim(t);
    });
    const offFinal = stt.on('final', (t) => submitTranscript(t));
    const offError = stt.on('error', (e) => {
      interimRef.current = '';
      setInterim('');
      setError(e.message);
      if (getAudioState() === 'listening') transition('idle');
    });
    const offEnd = stt.on('end', () => {
      const lingering = (interimRef.current || '').trim();
      if (lingering && getAudioState() === 'listening') {
        submitTranscript(lingering);
        return;
      }
      interimRef.current = '';
      setInterim('');
      if (getAudioState() === 'listening') transition('idle');
    });

    return () => { offInterim(); offFinal(); offError(); offEnd(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAsk = useCallback(async (qOverride, opts = {}) => {
    const q = (qOverride ?? question).trim();
    if (!q) return;
    setError('');
    setAnswer('');
    setLoading(true);
    // Asking a question resets the proactive dwell window in content.
    sendToTab(activeTabIdRef.current, { type: 'QUESTION_ASKED' });
    // And clear any pending offer card without re-dismissing the section.
    if (proactive) {
      setProactive(null);
      if (proactiveAutoDismissRef.current) {
        clearTimeout(proactiveAutoDismissRef.current);
        proactiveAutoDismissRef.current = null;
      }
    }

    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('No active tab found');
      const r = await fetchFocusFromTab(tab.id);
      if (!r?.ok) throw new Error(r?.error || 'Could not read focus from page');
      const payload = buildContextPayload(r.focus);
      setFocus(r.focus);

      const triggerHighlight = (sectionId) => {
        if (sectionId) sendToTab(tab.id, { type: 'WUBBLE_HIGHLIGHT', sectionId });
      };

      if (opts.audio) {
        const ac = new AbortController();
        bindAbortController(ac);
        transition('thinking');

        let buffer = '';
        let firstToken = true;
        const speakPromises = [];
        const speakOne = (s) => speakPromises.push(tts.speak(s).catch(() => {}));

        try {
          await streamAsk({
            payload,
            question: q,
            signal: ac.signal,
            onMeta: (m) => triggerHighlight(m?.sectionId),
            onToken: (tok) => {
              if (firstToken) {
                firstToken = false;
                if (getAudioState() === 'thinking') transition('speaking');
              }
              setAnswer((prev) => prev + tok);
              buffer += tok;
              buffer = flushSentences(buffer, speakOne);
            },
          });
        } catch (err) {
          if (err.name === 'AbortError') return;
          throw err;
        }
        const tail = buffer.trim();
        if (tail) speakOne(tail);
        await Promise.allSettled(speakPromises);
        clearAbortController();
        if (getAudioState() === 'speaking' || getAudioState() === 'thinking') {
          transition('idle');
        }
      } else {
        // Highlight from the focus we're sending; the server grounds in this
        // exact section, so we don't need to wait for a server echo.
        triggerHighlight(payload?.section?.id);
        const data = await askAboutPage({ payload, question: q });
        setAnswer(data.answer || '(empty response)');
      }
    } catch (e) {
      console.error('[wubble app] runAsk error:', e);
      setError(e.message);
      if (getAudioState() !== 'idle') transition('idle');
    } finally {
      setLoading(false);
    }
  }, [question, transition, proactive]);

  useEffect(() => { runAskRef.current = runAsk; }, [runAsk]);

  function handleMicClick() {
    if (audioState === 'listening') {
      transition('idle');
      return;
    }
    if (!isSTTAvailable()) {
      setError('Speech recognition is not supported in this browser.');
      return;
    }
    setQuestion('');
    setInterim('');
    transition('listening');
  }

  function handleStop() { transition('idle'); }

  function handleReplay() {
    if (!answer) return;
    if (speakerSpeakingRef.current) {
      tts.cancel();
      speakerSpeakingRef.current = false;
      return;
    }
    speakerSpeakingRef.current = true;
    tts.speak(answer).finally(() => { speakerSpeakingRef.current = false; });
  }

  function handleProactiveAccept() {
    const cur = proactive;
    if (!cur) return;
    setProactive(null);
    if (proactiveAutoDismissRef.current) {
      clearTimeout(proactiveAutoDismissRef.current);
      proactiveAutoDismissRef.current = null;
    }
    setQuestion('Explain this section simply');
    runAsk('Explain this section simply', { audio: false });
  }

  async function setCueEnabled(next) {
    setAudioCueEnabled(next);
    try { await chrome.storage.local.set({ [CUE_STORAGE_KEY]: next }); } catch {}
  }

  const showStop = audioState !== 'idle';
  const composedText = interim ? (question ? `${question} ${interim}` : interim) : question;

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="px-4 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold">Wubble</h1>
        <p className="text-xs text-slate-500">Context-aware reader assistant</p>
      </header>

      <div className="px-4 pt-3 flex items-center justify-between gap-2">
        <FocusPill focus={focus} />
        <StateIndicator state={audioState} />
      </div>

      <div className="px-4 pt-1 text-[11px] text-slate-500 flex items-center gap-2">
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={audioCueEnabled}
            onChange={(e) => setCueEnabled(e.target.checked)}
            className="accent-indigo-600"
          />
          <span>Audio cue on proactive offer</span>
        </label>
      </div>

      <main className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
        {proactive && (
          <ProactiveOffer
            heading={proactive.heading}
            onAccept={handleProactiveAccept}
            onDismiss={() => dismissProactive('user')}
          />
        )}

        <textarea
          value={composedText}
          onChange={(e) => { setQuestion(e.target.value); setInterim(''); }}
          placeholder="What is this section about? Explain this figure. Or hit the mic and ask out loud…"
          className="w-full min-h-[100px] p-2 border border-slate-300 rounded text-sm resize-none focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleMicClick}
            title={audioState === 'listening' ? 'Stop listening' : 'Hold a question'}
            className={`px-3 py-2 rounded font-medium border transition ${
              audioState === 'listening'
                ? 'bg-rose-600 text-white border-rose-700 animate-pulse'
                : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-100'
            }`}
          >
            🎤
          </button>
          <button
            type="button"
            onClick={() => runAsk()}
            disabled={loading || !question.trim()}
            className="flex-1 bg-slate-900 text-white py-2 rounded font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {loading ? 'Thinking…' : 'Ask about this page'}
          </button>
          {showStop && (
            <button
              type="button"
              onClick={handleStop}
              className="px-3 py-2 rounded font-medium bg-slate-200 hover:bg-slate-300 transition"
              title="Stop"
            >
              ◼
            </button>
          )}
        </div>

        {error && (
          <div className="text-red-700 text-sm bg-red-50 border border-red-200 p-2 rounded">
            {error}
          </div>
        )}

        {answer && (
          <section className="flex-1 overflow-auto bg-white border border-slate-200 rounded p-3 text-sm">
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={handleReplay}
                className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 transition"
                title="Replay aloud"
              >
                🔊 Replay
              </button>
            </div>
            <div className="whitespace-pre-wrap leading-relaxed">{answer}</div>
          </section>
        )}
      </main>
    </div>
  );
}
