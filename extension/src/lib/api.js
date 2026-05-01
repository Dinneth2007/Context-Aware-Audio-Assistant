const SERVER_URL = 'http://localhost:3001';

export async function askAboutPage({ context, question }) {
  const res = await fetch(`${SERVER_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, question }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Server ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}
