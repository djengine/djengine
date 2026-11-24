'use strict';

// Testler için Ollama'yı (yerel yapay zekâ sunucusu) taklit eden küçük HTTP sunucusu.
const http = require('http');

function createFakeOllama({ models = [] } = {}) {
  const state = { models: new Set(models), chats: [], pulls: 0 };
  const api = { state };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/api/tags') {
        return json(200, { models: [...state.models].map((name) => ({ name, size: 1 })) });
      }
      if (req.method === 'POST' && req.url === '/api/pull') {
        state.pulls++;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const steps = [
          { status: 'pulling manifest' },
          { status: 'downloading', total: 100, completed: 40 },
          { status: 'downloading', total: 100, completed: 100 },
          { status: 'success' },
        ];
        let i = 0;
        const next = () => {
          if (i < steps.length) {
            res.write(`${JSON.stringify(steps[i++])}\n`);
            setTimeout(next, 20);
          } else {
            state.models.add(body.model);
            res.end();
          }
        };
        return next();
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        state.chats.push(body);
        if (!state.models.has(body.model)) return json(404, { error: `model "${body.model}" not found, try pulling it first` });
        const system = (body.messages.find((m) => m.role === 'system') || {}).content || '';
        const last = body.messages[body.messages.length - 1].content;
        const content = /büyüme ve içerik stratejisti/.test(system)
          ? `## Analiz\nHesabınızda Reels'ler daha iyi gidiyor. Soru: ${last.slice(0, 40)}`
          : `Cevap: "Merhaba! Bilgileri hemen gönderiyorum 🙌"`;
        return json(200, { model: body.model, message: { role: 'assistant', content }, done: true });
      }
      json(404, { error: 'bilinmeyen uç' });
    });
  });
  api.listen = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        api.url = `http://127.0.0.1:${server.address().port}`;
        resolve(api.url);
      });
    });
  api.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return api;
}

module.exports = { createFakeOllama };
