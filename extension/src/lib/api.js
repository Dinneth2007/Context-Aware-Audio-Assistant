const SERVER_URL = 'http://localhost:3001';

export async function askAboutPage({ payload, question }) {
  const res = await fetch(`${SERVER_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, question }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Server ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// Streams SSE tokens from /api/chat. onToken is called with each text fragment.
// Resolves when the server emits [DONE]. Throws on abort or server error event.
export async function streamAsk({ payload, question, signal, onToken }) {
  const res = await fetch(`${SERVER_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ payload, question, stream: true }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Server ${res.status}: ${text || res.statusText}`);
  }
  if (!res.body) throw new Error('Server returned no body for stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payloadStr = dataLine.slice(5).trim();
      if (payloadStr === '[DONE]') return;
      try {
        const obj = JSON.parse(payloadStr);
        if (obj.error) throw new Error(obj.error);
        if (obj.token) onToken(obj.token);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
}
