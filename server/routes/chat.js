import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';

// gemini-2.0-flash: reliable streaming. gemini-2.5-flash returned empty
// streams (thinking-mode side effect) and intermittent 503s in this SDK
// path; revisit once the new genai SDK stabilizes 2.5 streaming.
const MODEL_NAME = 'gemini-2.0-flash';

let ai = null;
function getAI() {
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return ai;
}

function chunkText(chunk) {
  if (!chunk) return '';
  // .text getter (new SDK) or .text() method (old SDK)
  try {
    if (typeof chunk.text === 'function') {
      const t = chunk.text();
      if (t) return t;
    } else if (typeof chunk.text === 'string' && chunk.text) {
      return chunk.text;
    }
  } catch {}
  // Defensive: walk candidates → content.parts[].text
  const cands = chunk.candidates || chunk.response?.candidates || [];
  let out = '';
  for (const c of cands) {
    const parts = c?.content?.parts || [];
    for (const p of parts) if (typeof p?.text === 'string') out += p.text;
  }
  return out;
}

const router = Router();

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

router.post('/chat', async (req, res) => {
  const { payload, question, stream } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question (string) is required' });
  }

  const userText = buildUserContent(payload, question);
  const contents = [{ role: 'user', parts: [{ text: userText }] }];

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      const stream = await getAI().models.generateContentStream({
        model: MODEL_NAME,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      let emittedChars = 0;
      for await (const chunk of stream) {
        if (aborted) break;
        const token = chunkText(chunk);
        if (token) {
          emittedChars += token.length;
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }

      // Fallback: if streaming yielded no visible text (e.g. a model
      // routes content through a path our chunk reader misses),
      // do a non-streaming call and emit the whole answer as one token.
      if (!aborted && emittedChars === 0) {
        try {
          const resp = await getAI().models.generateContent({
            model: MODEL_NAME,
            contents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              temperature: 0.3,
              thinkingConfig: { thinkingBudget: 0 },
            },
          });
          const finalText = chunkText(resp);
          if (finalText) res.write(`data: ${JSON.stringify({ token: finalText })}\n\n`);
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
    const resp = await getAI().models.generateContent({
      model: MODEL_NAME,
      contents,
      config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.3 },
    });
    const answer = chunkText(resp);
    res.json({
      answer,
      model: MODEL_NAME,
      usage: resp.usageMetadata || null,
      focusSource: payload?.source || null,
      focusHeading: payload?.section?.heading || null,
    });
  } catch (err) {
    console.error('[wubble server] /api/chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
