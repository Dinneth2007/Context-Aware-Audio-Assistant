import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

// Provider selection — set LLM_PROVIDER=groq or =gemini in server/.env.
// Default groq because the free tier is far more generous than Gemini's.
const PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();

const MODELS = {
  groq:   'llama-3.3-70b-versatile',
  gemini: 'gemini-2.0-flash',
};
const MODEL_NAME = MODELS[PROVIDER] || MODELS.groq;

let geminiClient = null;
let groqClient = null;

function getGemini() {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
}
function getGroq() {
  if (!groqClient) groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  return groqClient;
}

function chunkText(chunk) {
  if (!chunk) return '';
  try {
    if (typeof chunk.text === 'function') {
      const t = chunk.text();
      if (t) return t;
    } else if (typeof chunk.text === 'string' && chunk.text) {
      return chunk.text;
    }
  } catch {}
  const cands = chunk.candidates || chunk.response?.candidates || [];
  let out = '';
  for (const c of cands) {
    const parts = c?.content?.parts || [];
    for (const p of parts) if (typeof p?.text === 'string') out += p.text;
  }
  return out;
}

const SYSTEM_PROMPT = `You are Wubble, a concise reading assistant embedded in a browser sidebar.

You receive a structured "focus" describing what the user is currently
attending to on the page. Your job is to answer their question grounded
in that focus.

Rules:
- The user is currently focused on a specific section. Answer based on
  that section unless the question is clearly about the whole page
  (e.g. "summarize the page", "what is this article about overall").
- The page outline is provided for orientation only — don't fabricate
  content from headings you weren't given the body of.
- If the user has selected text, treat that selection as the most
  important signal. The question is almost certainly about it.
- If a figure/table is hovered, lean toward explaining that element.
- If the section is missing or empty, say so plainly. Don't make up
  content.
- Keep answers under 120 words by default. Only go longer if the user
  explicitly asks for detail, depth, or a long-form explanation.
- Prefer plain prose. Use bullets only when the answer is genuinely a
  list. When your answer is going to be spoken aloud, prefer flowing
  prose over bullets.`;

function formatPayload(payload) {
  if (!payload) return '(no context provided)';
  if (payload.pageMeta?.restricted) {
    return `RESTRICTED PAGE: ${payload.pageMeta.restrictedReason || 'cannot read this page directly.'}\nTitle: ${payload.pageMeta.title}\nURL: ${payload.pageMeta.url}`;
  }
  const lines = [];
  lines.push(`Page title: ${payload.pageMeta?.title || '(unknown)'}`);
  lines.push(`Page URL: ${payload.pageMeta?.url || '(unknown)'}`);
  lines.push(`Focus source: ${payload.source}`);
  if (payload.section) {
    lines.push(`Focused section heading: "${payload.section.heading}"`);
  } else {
    lines.push('Focused section: (none detected)');
  }
  if (payload.selectedText) {
    lines.push(`User selected text: """${payload.selectedText}"""`);
  }
  if (payload.hoveredElement) {
    lines.push(`Hovered element (${payload.hoveredElement.type}): "${payload.hoveredElement.text || ''}"`);
  }
  if (Array.isArray(payload.pageOutline) && payload.pageOutline.length > 0) {
    lines.push('Page outline (headings only):');
    for (const o of payload.pageOutline) lines.push(`  - ${o.heading}`);
  }
  if (payload.section?.text) {
    lines.push('');
    lines.push('Focused section text:');
    lines.push('"""');
    lines.push(payload.section.text);
    lines.push('"""');
  }
  return lines.join('\n');
}

function buildUserContent(payload, question) {
  return `${formatPayload(payload)}\n\nQuestion: ${question}`;
}

// ---------- Provider adapters ----------
// Each yields plain text fragments. Server packs them into SSE.
async function* streamGenerate(userText) {
  if (PROVIDER === 'gemini') {
    const stream = await getGemini().models.generateContentStream({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    for await (const chunk of stream) yield chunkText(chunk);
    return;
  }
  // groq (OpenAI-compatible)
  const stream = await getGroq().chat.completions.create({
    model: MODEL_NAME,
    temperature: 0.3,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
  });
  for await (const chunk of stream) {
    yield chunk.choices?.[0]?.delta?.content || '';
  }
}

async function generateOnce(userText) {
  if (PROVIDER === 'gemini') {
    const resp = await getGemini().models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.3 },
    });
    return { text: chunkText(resp), usage: resp.usageMetadata || null };
  }
  const resp = await getGroq().chat.completions.create({
    model: MODEL_NAME,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
  });
  return { text: resp.choices?.[0]?.message?.content || '', usage: resp.usage || null };
}

const router = Router();

router.post('/chat', async (req, res) => {
  const { payload, question, stream } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question (string) is required' });
  }

  const userText = buildUserContent(payload, question);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      const groundedId = payload?.section?.id || null;
      if (groundedId) {
        res.write(`event: meta\ndata: ${JSON.stringify({ sectionId: groundedId })}\n\n`);
      }

      let emittedChars = 0;
      for await (const text of streamGenerate(userText)) {
        if (aborted) break;
        if (text) {
          emittedChars += text.length;
          res.write(`data: ${JSON.stringify({ token: text })}\n\n`);
        }
      }

      if (!aborted && emittedChars === 0) {
        try {
          const { text } = await generateOnce(userText);
          if (text) res.write(`data: ${JSON.stringify({ token: text })}\n\n`);
        } catch (e) {
          console.error('[wubble server] non-streaming fallback failed:', e.message);
        }
      }

      if (!aborted) res.write('data: [DONE]\n\n');
    } catch (err) {
      console.error('[wubble server] /api/chat stream error:', err);
      try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); } catch {}
    } finally {
      res.end();
    }
    return;
  }

  try {
    const { text, usage } = await generateOnce(userText);
    res.json({
      answer: text,
      model: MODEL_NAME,
      provider: PROVIDER,
      usage,
      focusSource: payload?.source || null,
      focusHeading: payload?.section?.heading || null,
    });
  } catch (err) {
    console.error('[wubble server] /api/chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

console.log(`[wubble server] LLM provider: ${PROVIDER} (${MODEL_NAME})`);

export default router;
