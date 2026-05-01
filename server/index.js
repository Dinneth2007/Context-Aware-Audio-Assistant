import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.warn('[wubble server] OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/chat', async (req, res) => {
  const { context, question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question (string) is required' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'You are Wubble, a concise reading assistant. Answer the user strictly using the page context they provide. If the context is missing or insufficient, say so plainly. Prefer short, structured answers.',
        },
        {
          role: 'user',
          content: `Page context:\n"""\n${context || '(no context provided)'}\n"""\n\nQuestion: ${question}`,
        },
      ],
    });

    res.json({
      answer: completion.choices[0]?.message?.content ?? '',
      model: completion.model,
      usage: completion.usage,
    });
  } catch (err) {
    console.error('[wubble server] /api/chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[wubble server] listening on http://localhost:${PORT}`);
});
