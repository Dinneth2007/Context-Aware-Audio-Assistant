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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function fetchFocusFromTab(tabId) {
  return chrome.tabs
    .sendMessage(tabId, { type: 'GET_FOCUS' })
    .catch(() => ({ ok: false, error: 'content script unreachable — refresh the page' }));
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

  const { state: audioState, transition } = useAudioState();
  const sttRef = useRef(null);
  const focusDebounce = useRef(null);
  const speakerSpeakingRef = useRef(false);

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

  useEffect(() => {
    function onMsg(msg, sender) {
      if (msg?.type !== 'FOCUS_CHANGE') return;
      if (activeTabId != null && sender?.tab?.id !== activeTabId) return;
      if (focusDebounce.current) clearTimeout(focusDebounce.current);
      focusDebounce.current = setTimeout(() => setFocus(msg.focus), 500);
    }
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      if (focusDebounce.current) clearTimeout(focusDebounce.current);
    };
  }, [activeTabId]);

  useEffect(() => {
    function onActivated({ tabId }) {
      setActiveTabId(tabId);
      fetchFocusFromTab(tabId).then((r) => { if (r?.ok && r.focus) setFocus(r.focus); });
    }
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, []);

  useEffect(() => {
    if (!isSTTAvailable()) return;
    const stt = createSTT();
    sttRef.current = stt;
    bindSTT(stt);

    const offInterim = stt.on('interim', (t) => setInterim(t));
    const offFinal = stt.on('final', (t) => {
      setInterim('');
      setQuestion(t);
      runAsk(t, { audio: true });
    });
    const offError = stt.on('error', (e) => {
      setInterim('');
      setError(e.message);
      if (getAudioState() === 'listening') transition('idle');
    });
    const offEnd = stt.on('end', () => {
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
    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('No active tab found');
      const r = await fetchFocusFromTab(tab.id);
      if (!r?.ok) throw new Error(r?.error || 'Could not read focus from page');
      const payload = buildContextPayload(r.focus);
      setFocus(r.focus);

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
        const data = await askAboutPage({ payload, question: q });
        setAnswer(data.answer || '(empty response)');
      }
    } catch (e) {
      setError(e.message);
      if (getAudioState() !== 'idle') transition('idle');
    } finally {
      setLoading(false);
    }
  }, [question, transition]);

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

      <main className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
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
