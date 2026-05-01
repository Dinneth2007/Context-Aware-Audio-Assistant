import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.warn('[wubble server] OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
}

const { default: chatRouter } = await import('./routes/chat.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', chatRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[wubble server] listening on http://localhost:${PORT}`);
});
