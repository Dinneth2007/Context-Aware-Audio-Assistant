import { Router } from 'express';
import OpenAI from 'openai';

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

const router = Router();
const ALLOWED_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
const MAX_INPUT_CHARS = 4000;

router.post('/tts', async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text (string) is required' });
  }
  const cleanVoice = ALLOWED_VOICES.has(voice) ? voice : 'alloy';
  const input = text.slice(0, MAX_INPUT_CHARS);

  try {
    const speech = await getOpenAI().audio.speech.create({
      model: 'tts-1',
      voice: cleanVoice,
      input,
      response_format: 'mp3',
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    const stream = speech.body;
    if (stream && typeof stream.pipe === 'function') {
      stream.pipe(res);
    } else if (typeof speech.arrayBuffer === 'function') {
      const buf = Buffer.from(await speech.arrayBuffer());
      res.end(buf);
    } else {
      throw new Error('TTS response had no pipeable body or arrayBuffer');
    }
  } catch (err) {
    console.error('[wubble server] /api/tts error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

export default router;
