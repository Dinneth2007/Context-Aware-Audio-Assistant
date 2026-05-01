import { useEffect, useRef, useState } from 'react';
import { askAboutPage } from '../lib/api.js';
import { buildContextPayload } from '../lib/context.js';

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

export default function App() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState(null);
  const [activeTabId, setActiveTabId] = useState(null);
  const debounceRef = useRef(null);

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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setFocus(msg.focus), 500);
    }
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      if (debounceRef.current) clearTimeout(debounceRef.current);
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

  async function handleAsk() {
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
      const data = await askAboutPage({ payload, question: question.trim() });
      setAnswer(data.answer || '(empty response)');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="px-4 py-3 border-b bg-white">
        <h1 className="text-lg font-semibold">Wubble</h1>
        <p className="text-xs text-slate-500">Context-aware reader assistant</p>
      </header>

      <div className="px-4 pt-3">
        <FocusPill focus={focus} />
      </div>

      <main className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What is this section about? Explain this figure. Summarize the page…"
          className="w-full min-h-[110px] p-2 border border-slate-300 rounded text-sm resize-none focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button
          onClick={handleAsk}
          disabled={loading || !question.trim()}
          className="bg-slate-900 text-white py-2 rounded font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {loading ? 'Thinking…' : 'Ask about this page'}
        </button>

        {error && (
          <div className="text-red-700 text-sm bg-red-50 border border-red-200 p-2 rounded">
            {error}
          </div>
        )}

        {answer && (
          <section className="flex-1 overflow-auto bg-white border border-slate-200 rounded p-3 text-sm">
            <div className="whitespace-pre-wrap leading-relaxed">{answer}</div>
          </section>
        )}
      </main>
    </div>
  );
}
