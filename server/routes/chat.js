import { Router } from 'express';
import OpenAI from 'openai';

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
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

function buildMessages(payload, question) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${formatPayload(payload)}\n\nQuestion: ${question}` },
  ];
}

router.post('/chat', async (req, res) => {
  const { payload, question, stream } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question (string) is required' });
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      const completion = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        stream: true,
        messages: buildMessages(payload, question),
      });
      for await (const chunk of completion) {
        if (aborted) break;
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
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
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: buildMessages(payload, question),
    });

    res.json({
      answer: completion.choices[0]?.message?.content ?? '',
      model: completion.model,
      usage: completion.usage,
      focusSource: payload?.source || null,
      focusHeading: payload?.section?.heading || null,
    });
  } catch (err) {
    console.error('[wubble server] /api/chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
