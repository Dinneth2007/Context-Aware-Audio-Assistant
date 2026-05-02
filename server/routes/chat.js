import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

let genai = null;
function getModel() {
  if (!genai) genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genai.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: { temperature: 0.3 },
  });
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
      const result = await getModel().generateContentStream({ contents });
      let chunkCount = 0;
      let emittedChars = 0;
      for await (const chunk of result.stream) {
        if (aborted) break;
        chunkCount++;
        const token = typeof chunk.text === 'function' ? chunk.text() : '';
        console.log('[wubble server] chunk', chunkCount, 'text len:', (token || '').length);
        if (token) {
          emittedChars += token.length;
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      }
      console.log('[wubble server] stream loop done. chunks:', chunkCount, 'emittedChars:', emittedChars);

      // Fallback: if streaming produced nothing, drain the aggregated
      // response (useful when 2.5 models route content through paths
      // where chunk.text() comes back empty in this SDK).
      if (!aborted && emittedChars === 0) {
        try {
          const finalResp = await result.response;
          const finalText = typeof finalResp.text === 'function' ? finalResp.text() : '';
          console.log('[wubble server] streaming was empty; final response chars:', (finalText || '').length);
          if (finalText) {
            res.write(`data: ${JSON.stringify({ token: finalText })}\n\n`);
          }
        } catch (e) {
          console.error('[wubble server] final-response fallback failed:', e.message);
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
    const result = await getModel().generateContent({ contents });
    const answer = result.response.text();
    const usage = result.response.usageMetadata || null;
    res.json({
      answer,
      model: 'gemini-2.5-flash',
      usage,
      focusSource: payload?.source || null,
      focusHeading: payload?.section?.heading || null,
    });
  } catch (err) {
    console.error('[wubble server] /api/chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
