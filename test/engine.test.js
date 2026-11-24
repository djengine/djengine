'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/core/store');
const { Engine } = require('../src/core/engine');
const { InstagramClient } = require('../src/core/instagram');
const { createFakeInstagram } = require('./fake-instagram');

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60 * 1000;

async function setup({ dryRun = false } = {}) {
  const fake = createFakeInstagram();
  await fake.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmotest-'));
  const store = new Store(path.join(dir, 'data.json'));
  store.updateSettings({ dryRun });
  const engine = new Engine({ store, clientFactory: (t) => new InstagramClient(t, { baseUrl: fake.url }), random: () => 0 });
  const igAcc = fake.addAccount('dj_engine');
  const acc = store.upsertAccount({
    igUserId: igAcc.user_id,
    username: 'dj_engine',
    token: igAcc.session,
    connectedAt: new Date().toISOString(),
  });
  acc.baselineAt = ago(60 * MIN);
  return { fake, store, engine, acc, dir };
}

test('yorumdaki anahtar kelimeye özel DM ve herkese açık cevap gönderilir', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'Yeni set');
  store.saveRule({
    name: 'Set linki',
    accountId: acc.id,
    type: 'comment',
    keywords: 'set, link',
    mediaScope: 'all',
    dmText: 'Selam {username}, link burada 🎧',
    publicReplyEnabled: true,
    publicReplyText: 'DM attım 🔥',
  });
  fake.addComment('dj_engine', post.id, { username: 'ali', text: 'SET lütfen' });
  fake.addComment('dj_engine', post.id, { username: 'veli', text: 'harika paylaşım' });

  await engine.tick();

  const dms = fake.state.sent.filter((s) => s.kind === 'dm');
  assert.equal(dms.length, 1);
  assert.equal(dms[0].to, 'u-ali');
  assert.equal(dms[0].text, 'Selam @ali, link burada 🎧');
  const pub = fake.state.sent.filter((s) => s.kind === 'public_reply');
  assert.equal(pub.length, 1);
  // Büyük id'ler hassasiyet kaybetmeden taşınır
  assert.equal(pub[0].mediaId, post.id);
  assert.equal(pub[0].commentId, post.comments.find((c) => c.text === 'SET lütfen').pk);
  assert.equal(pub[0].text, 'DM attım 🔥');
  assert.equal(store.data.log.filter((l) => l.type === 'sent').length, 1);

  // İkinci turda aynı yorum tekrar işlenmez, yorum sayısı değişmediği için yorumlar çekilmez
  const before = fake.state.requests.length;
  await engine.tick();
  assert.equal(fake.state.sent.length, 2);
  const commentFetches = fake.state.requests.slice(before).filter((r) => r.path.endsWith('/comments/'));
  assert.equal(commentFetches.length, 0);
});

test('aynı kişiye aynı kuraldan ikinci kez gönderilmez', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: 'link', mediaScope: 'all', dmText: 'link' });
  fake.addComment('dj_engine', post.id, { username: 'ali', text: 'link' });
  await engine.tick();
  fake.addComment('dj_engine', post.id, { username: 'ali', text: 'link link' });
  await engine.tick();
  assert.equal(fake.state.sent.length, 1);
  assert.ok(store.data.log.some((l) => l.type === 'skip'));
});

test('uygulama kurulmadan önceki ve kendi yorumlarımız işlenmez', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: '', mediaScope: 'all', dmText: 'hey' });
  fake.addComment('dj_engine', post.id, { username: 'eski', text: 'merhaba', createdAt: Math.floor((Date.now() - 120 * MIN) / 1000) });
  fake.addComment('dj_engine', post.id, { username: 'dj_engine', text: 'teşekkürler', fromId: acc.igUserId });
  await engine.tick();
  assert.equal(fake.state.sent.length, 0);
});

test('sadece seçili gönderilerde çalışan kural', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const a = fake.addMedia('dj_engine', 'a');
  const b = fake.addMedia('dj_engine', 'b');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: 'link', mediaScope: 'selected', mediaIds: [a.id], dmText: 'hey' });
  fake.addComment('dj_engine', a.id, { username: 'x1', text: 'link' });
  fake.addComment('dj_engine', b.id, { username: 'x2', text: 'link' });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.to), ['u-x1']);
});

test('test modunda hiçbir şey gönderilmez, sadece kaydedilir', async (t) => {
  const { fake, store, engine, acc } = await setup({ dryRun: true });
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: 'link', mediaScope: 'all', dmText: 'hey {username}' });
  fake.addComment('dj_engine', post.id, { username: 'ali', text: 'link' });
  await engine.tick();
  assert.equal(fake.state.sent.length, 0);
  const dry = store.data.log.find((l) => l.type === 'dry');
  assert.equal(dry.reply, 'hey @ali');
});

test('DM anahtar kelimesine cevap verilir, kendi mesajlarımıza verilmez', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  store.saveRule({ name: 'Booking', accountId: acc.id, type: 'dm', keywords: 'booking, fiyat', dmText: 'Booking için: mail@ornek.com' });
  fake.addMessage('dj_engine', { username: 'mekan', text: 'Fiyat bilgisi alabilir miyim?' });
  fake.addMessage('dj_engine', { username: 'arkadas', text: 'naber' });
  await engine.tick();
  assert.deepEqual(fake.state.sent, [{ kind: 'dm', to: 'u-mekan', text: 'Booking için: mail@ornek.com' }]);
  await engine.tick();
  assert.equal(fake.state.sent.length, 1);
});

test('Instagram oturumu kapanınca hesap "yeniden giriş" durumuna alınır', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: '', mediaScope: 'all', dmText: 'hey' });
  fake.expireSession('dj_engine');
  await engine.tick();
  assert.equal(acc.status, 'auth');
  assert.match(acc.lastError, /yeniden giriş/);
  // Sonraki turlarda bu hesap için istek atılmaz
  const n = fake.state.requests.length;
  await engine.tick();
  assert.equal(fake.state.requests.length, n);
});

test('istek limitinde gönderilmemiş yorum sonra tekrar denenir', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: '', mediaScope: 'all', dmText: 'hey' });
  fake.addComment('dj_engine', post.id, { username: 'ali', text: 'selam' });
  // Gönderi ve yorumlar başarılı, DM gönderimi limit hatası alsın
  const origPush = fake.state.requests.push.bind(fake.state.requests);
  fake.state.requests.push = (r) => {
    if (r.path === '/api/v1/direct_v2/threads/broadcast/text/' && !fake._limited) {
      fake._limited = true;
      fake.state.failNext = { status: 429, body: { message: 'Please wait a few minutes before you try again.', status: 'fail' } };
    }
    return origPush(r);
  };
  await engine.tick();
  assert.equal(acc.status, 'limit');
  assert.equal(fake.state.sent.length, 0);
  acc.backoffUntil = null; // bekleme süresi doldu varsayalım
  await engine.tick();
  assert.equal(fake.state.sent.length, 1);
  assert.equal(acc.status, 'ok');
});

test('saatlik gönderim sınırı aşılmaz', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  store.updateSettings({ maxSendsPerHour: 2 });
  const post = fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: '', mediaScope: 'all', dmText: 'hey' });
  for (const u of ['a', 'b', 'c', 'd']) fake.addComment('dj_engine', post.id, { username: u, text: 'selam' });
  await engine.tick();
  assert.equal(fake.state.sent.length, 2);
});

test('veriler kaydedilir ve oturum bilgisi şifrelenerek yazılır', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmotest-'));
  const file = path.join(dir, 'data.json');
  const enc = { encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s, 'base64').toString() };
  const s1 = new Store(file, enc);
  s1.upsertAccount({ igUserId: '1', username: 'gsridercyprus', token: 'GIZLI-TOKEN' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('GIZLI-TOKEN'));
  const s2 = new Store(file, enc);
  assert.equal(s2.data.accounts[0].token, 'GIZLI-TOKEN');
  // Aynı hesap tekrar bağlanınca çoğalmaz
  s2.upsertAccount({ igUserId: '1', username: 'gsridercyprus', token: 'YENI' });
  assert.equal(s2.data.accounts.length, 1);
});

test('bozuk veri dosyası uygulamayı çökertmez', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmotest-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{bozuk');
  const s = new Store(file);
  assert.deepEqual(s.data.accounts, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('bozuk')));
});

test('oturum çerezleri doğru okunur ve büyük sayılar metin olarak korunur', () => {
  const { parseCookies, parseJson } = require('../src/core/instagram');
  assert.deepEqual(parseCookies('sessionid=abc%3A1; ds_user_id=42; csrftoken=x'), { sessionid: 'abc%3A1', ds_user_id: '42', csrftoken: 'x' });
  const j = parseJson('{"pk":3456789012345678901,"n":5,"items":[17912345678901234],"t":"a:12"}');
  assert.equal(j.pk, '3456789012345678901');
  assert.equal(j.n, 5);
  assert.deepEqual(j.items, ['17912345678901234']);
});
