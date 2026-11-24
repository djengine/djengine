'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AI, DEFAULT_MODEL } = require('../src/core/ai');
const { createFakeOllama } = require('./fake-ollama');

test('Ollama kapalıyken anlaşılır hata ve durum verilir', async () => {
  const ai = new AI(() => ({ url: 'http://127.0.0.1:9' }));
  const st = await ai.status();
  assert.equal(st.running, false);
  await assert.rejects(() => ai.reply({ account: 'a', incoming: 'x' }), /Ollama çalışmıyor/);
});

test('model indirilmemişse söylenir; indirilince cevap üretilir', async (t) => {
  const fake = createFakeOllama();
  await fake.listen();
  t.after(() => fake.close());
  const ai = new AI(() => ({ url: fake.url }));
  assert.deepEqual(await ai.status(), { running: true, model: DEFAULT_MODEL, installed: false, models: [] });
  await assert.rejects(() => ai.reply({ account: 'a', incoming: 'x' }), /indirilmemiş/);

  const progress = [];
  await ai.pull((pct) => progress.push(pct));
  assert.ok(progress.includes(100));
  assert.equal((await ai.status()).installed, true);

  const text = await ai.reply({ account: 'dj_engine', instructions: 'Fiyat: 500 TL', kind: 'comment', username: 'ali', incoming: 'fiyat?' });
  assert.equal(text, 'Merhaba! Bilgileri hemen gönderiyorum 🙌'); // "Cevap:" ve tırnaklar temizlenir
  const req = fake.state.chats.at(-1);
  assert.equal(req.model, DEFAULT_MODEL);
  assert.equal(req.stream, false);
  assert.match(req.messages[1].content, /<gelen_mesaj>\nfiyat\?\n<\/gelen_mesaj>/);
  assert.match(req.messages[1].content, /Fiyat: 500 TL/);
});

test('asistan sohbeti hesap verisini sistem mesajında gönderir', async (t) => {
  const fake = createFakeOllama({ models: ['qwen2.5:3b'] });
  await fake.listen();
  t.after(() => fake.close());
  const ai = new AI(() => ({ url: fake.url, model: 'qwen2.5:3b' }));
  const out = await ai.chat({ context: 'Takipçi: 1200', messages: [{ role: 'user', content: 'Hesabımı analiz et' }] });
  assert.match(out, /Analiz/);
  const sys = fake.state.chats.at(-1).messages[0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /<hesap_verileri>\nTakipçi: 1200/);
});
