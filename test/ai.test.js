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

test('"Beni tanı" bilgileri, örnek cevaplar ve sohbet geçmişi yapay zekâya gider', async (t) => {
  const fake = createFakeOllama({ models: [DEFAULT_MODEL] });
  await fake.listen();
  t.after(() => fake.close());
  const ai = new AI(() => ({ url: fake.url }));
  const persona = {
    about: 'DJ Engine, düğün ve kulüp DJ\'i',
    goals: 'Yaz sezonu düğün rezervasyonu',
    info: 'Düğün paketi 15.000 TL. Mail: booking@dj.com',
    address: 'sen',
    emoji: 'az',
    never: 'Tarih sözü verme',
    examples: [{ in: 'fiyat ne?', out: 'Selam! Düğün paketim 15.000 TL 🎧 Tarihin ne?' }],
  };
  await ai.reply({
    account: 'dj_engine', kind: 'dm', username: 'gelin', incoming: 'ağustosta müsait misin?', persona,
    history: [{ me: false, text: 'merhaba' }, { me: true, text: 'Selam, buyur!' }],
  });
  const msgs = fake.state.chats.at(-1).messages;
  assert.match(msgs[0].content, /<hakkimda>\nDJ Engine/);
  assert.match(msgs[0].content, /<bilgilerim>\nDüğün paketi 15\.000 TL/);
  assert.match(msgs[0].content, /"sen" diye hitap/);
  assert.match(msgs[0].content, /<asla_yapma>\nTarih sözü verme/);
  // Örnek: kullanıcı/asistan çifti olarak
  assert.deepEqual([msgs[1].role, msgs[2].role], ['user', 'assistant']);
  assert.match(msgs[1].content, /fiyat ne\?/);
  assert.equal(msgs[2].content, 'Selam! Düğün paketim 15.000 TL 🎧 Tarihin ne?');
  const last = msgs.at(-1).content;
  assert.match(last, /<sohbet_gecmisi>\n@gelin: merhaba\nBen: Selam, buyur!\n<\/sohbet_gecmisi>/);
  assert.match(last, /ağustosta müsait misin\?/);
});

test('asistan da hesap sahibinin hedeflerini bilir', async (t) => {
  const fake = createFakeOllama({ models: [DEFAULT_MODEL] });
  await fake.listen();
  t.after(() => fake.close());
  const ai = new AI(() => ({ url: fake.url }));
  await ai.chat({ context: 'x', messages: [{ role: 'user', content: 'plan yap' }], persona: { goals: '10 bin takipçi' } });
  assert.match(fake.state.chats.at(-1).messages[0].content, /<hedeflerim>\n10 bin takipçi/);
});
