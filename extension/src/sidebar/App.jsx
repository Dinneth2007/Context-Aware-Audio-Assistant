import { useState } from 'react';
import { askAboutPage } from '../lib/api.js';

export default function App() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleAsk() {
    setError('');
    setAnswer('');
    setPageTitle('');
    setLoading(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found');

      const ctx = await chrome.tabs
        .sendMessage(tab.id, { type: 'EXTRACT_CONTEXT' })
        .catch(() => {
          throw new Error(
            'Could not reach content script. Refresh the page and try again (content scripts only inject on tabs loaded after the extension was installed).'
          );
        });

      if (!ctx?.ok) throw new Error(ctx?.error || 'Context extraction failed');
      setPageTitle(ctx.title || tab.title || '');

      const data = await askAboutPage({
        context: (ctx.text || '').slice(0, 12000),
        question: question.trim(),
      });
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

      <main className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What is this page about? Summarize it. Explain section 2..."
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

        {(pageTitle || answer) && (
          <section className="flex-1 overflow-auto bg-white border border-slate-200 rounded p-3 text-sm">
            {pageTitle && (
              <div className="text-xs text-slate-500 mb-2 truncate">📄 {pageTitle}</div>
            )}
            {answer && <div className="whitespace-pre-wrap leading-relaxed">{answer}</div>}
          </section>
        )}
      </main>
    </div>
  );
}
