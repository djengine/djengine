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

// ---------------- Yeni özellikler ----------------

test('takip şartı: takip etmeyene önce "takip et" mesajı, takip edip yazınca asıl mesaj gider', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'Ücretsiz set');
  const rule = store.saveRule({
    name: 'Set (takip şartlı)', accountId: acc.id, type: 'comment', keywords: 'set', mediaScope: 'all',
    dmText: 'İşte link: https://ornek.com/set', followGate: true, followPrompt: 'Önce takip et {username}',
  });
  fake.addComment('dj_engine', post.id, { username: 'ali', text: 'SET' });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.text), ['Önce takip et @ali']);
  assert.ok(store.data.log.some((l) => l.type === 'gate'));

  // Takip etmeden yazarsa asıl mesaj gitmez
  fake.addMessage('dj_engine', { username: 'ali', text: 'tamam' });
  await engine.tick();
  assert.equal(fake.state.sent.length, 1);

  // Takip edip yazınca asıl mesaj gider
  fake.follow('dj_engine', 'u-ali');
  fake.addMessage('dj_engine', { username: 'ali', text: 'takip ettim' });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.text), ['Önce takip et @ali', 'İşte link: https://ornek.com/set']);
  const stats = store.data.stats[rule.id];
  assert.equal(stats.triggered, 1);
  assert.equal(stats.gated, 1);
  assert.equal(stats.unlocked, 1);
  assert.equal(stats.sent, 1);
});

test('takip şartı: zaten takip eden doğrudan asıl mesajı alır', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const post = fake.addMedia('dj_engine', 'x');
  store.saveRule({ name: 'r', accountId: acc.id, type: 'comment', keywords: '', mediaScope: 'all', dmText: 'link', followGate: true });
  fake.follow('dj_engine', 'u-veli');
  fake.addComment('dj_engine', post.id, { username: 'veli', text: 'selam' });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.text), ['link']);
});

test('gönderi kapsamı: sadece Reels ve belirli tarihten sonraki gönderiler', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  const old = fake.addMedia('dj_engine', 'eski', Math.floor(Date.parse('2026-01-01') / 1000));
  const fresh = fake.addMedia('dj_engine', 'yeni', Math.floor(Date.now() / 1000));
  const reel = fake.addMedia('dj_engine', 'reels', Math.floor(Date.now() / 1000), { reel: true });
  store.saveRule({ name: 'reels', accountId: acc.id, type: 'comment', keywords: 'reel', mediaScope: 'reels', dmText: 'R' });
  store.saveRule({ name: 'tarih', accountId: acc.id, type: 'comment', keywords: 'tarih', mediaScope: 'since', sinceDate: '2026-06-01', dmText: 'T' });
  for (const m of [old, fresh, reel]) {
    fake.addComment('dj_engine', m.id, { username: `a${m.caption}`, text: 'reel' });
    fake.addComment('dj_engine', m.id, { username: `b${m.caption}`, text: 'tarih' });
  }
  await engine.tick();
  const got = fake.state.sent.map((s) => `${s.text}:${s.to}`).sort();
  assert.deepEqual(got, ['R:u-areels', 'T:u-breels', 'T:u-byeni']);
});

test('hikâye cevabı tetikleyicisi sadece hikâye cevaplarında çalışır', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  store.saveRule({ name: 'Hikâye', accountId: acc.id, type: 'story', keywords: 'bilet', dmText: 'Bilet linki: x' });
  fake.addMessage('dj_engine', { username: 'h1', text: 'bilet var mı?', story: true });
  fake.addMessage('dj_engine', { username: 'd1', text: 'bilet var mı?' });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.to), ['u-h1']);
  assert.equal(store.data.log.find((l) => l.type === 'sent').trigger, 'story');
});

test('DM\'de verilen e-posta ve telefon kişilere kaydedilir', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  store.saveRule({ name: 'Booking', accountId: acc.id, type: 'dm', keywords: 'booking', dmText: 'Mailini yazar mısın?' });
  fake.addMessage('dj_engine', { username: 'mekan', text: 'booking için yazıyorum' });
  await engine.tick();
  fake.addMessage('dj_engine', { username: 'mekan', text: 'mailim info@mekan.com, tel +90 532 123 45 67' });
  await engine.tick();
  const c = store.data.contacts.find((x) => x.username === 'mekan');
  assert.equal(c.email, 'info@mekan.com');
  assert.equal(c.phone, '+90 532 123 45 67');
  assert.deepEqual(c.tags, ['Booking']);
  assert.ok(store.data.log.some((l) => l.type === 'lead'));
});

test('yapay zekâ cevabı: metni yapay zekâ yazar; yapay zekâ çalışmıyorsa mesaj kaybolmaz', async (t) => {
  const { fake, store, acc } = await setup();
  t.after(() => fake.close());
  let up = false;
  const calls = [];
  const ai = {
    async reply(args) {
      calls.push(args);
      if (!up) throw new Error('Ollama çalışmıyor');
      return `Merhaba @${args.username}, fiyatlar DM'de 🙌`;
    },
  };
  const engine = new Engine({ store, clientFactory: (tk) => new InstagramClient(tk, { baseUrl: fake.url }), random: () => 0, ai });
  store.saveRule({ name: 'AI', accountId: acc.id, type: 'dm', keywords: '', dmText: '', replyMode: 'ai', aiInstructions: 'Kibar ol' });
  fake.addMessage('dj_engine', { username: 'musteri', text: 'fiyat nedir' });
  await engine.tick();
  assert.equal(fake.state.sent.length, 0);
  assert.match(acc.lastError, /Yapay zekâ/);
  up = true;
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.text), ["Merhaba @musteri, fiyatlar DM'de 🙌"]);
  assert.equal(calls.at(-1).instructions, 'Kibar ol');
  assert.equal(calls.at(-1).incoming, 'fiyat nedir');
  assert.equal(calls.at(-1).kind, 'dm');
});

test('kişi bilgisi ayıklama', () => {
  const { extractLead } = require('../src/core/engine');
  assert.deepEqual(extractLead('mail: a.b+c@x.com.tr'), { email: 'a.b+c@x.com.tr', phone: null });
  assert.deepEqual(extractLead('05321234567 ara'), { email: null, phone: '05321234567' });
  assert.deepEqual(extractLead('2026 yılında 3 set'), { email: null, phone: null });
});

test('Instagram API istekleri i.instagram.com\'a, web yorum cevabı www\'ya gider (www\'da DM kutusu 404 veriyor)', async () => {
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ status: 'ok', inbox: { threads: [] }, items: [] }), { status: 200 });
  };
  const c = new InstagramClient('sessionid=s; ds_user_id=42; csrftoken=x', { fetchImpl, baseUrl: 'https://www.instagram.com' });
  await c.conversations();
  await c.recentMedia(3);
  await c.replyToComment('99', 'tesekkurler', { mediaId: '77' });
  assert.ok(urls.some((u) => u.startsWith('https://i.instagram.com/api/v1/direct_v2/inbox/')), urls.join('\n'));
  assert.ok(urls.some((u) => u.startsWith('https://i.instagram.com/api/v1/feed/user/42/')), urls.join('\n'));
  assert.ok(urls.some((u) => u.startsWith('https://www.instagram.com/api/v1/web/comments/77/add/')), urls.join('\n'));
});

test('Instagram hata mesajı hangi adımın başarısız olduğunu söyler', async () => {
  const fetchImpl = async () => new Response('<html>yok</html>', { status: 404 });
  const c = new InstagramClient('sessionid=s; ds_user_id=42; csrftoken=x', { fetchImpl, baseUrl: 'https://www.instagram.com' });
  await assert.rejects(() => c.conversations(), /DM kutusu.*404/);
});

test('mesaj istekleri kutusundaki DM\'ler de okunur; cevaptan önce istek kabul edilir', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  store.saveRule({ name: 'Fiyat', accountId: acc.id, type: 'dm', keywords: 'fiyat', dmText: 'Fiyat listesi: x' });
  fake.addMessage('dj_engine', { username: 'yabanci', text: 'fiyat?', pending: true });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.to), ['u-yabanci']);
  assert.equal(fake.state.approved, 1);
});

test('yapay zekâ cevabına hesap profili ve sohbet geçmişi eklenir', async (t) => {
  const { fake, store, acc } = await setup();
  t.after(() => fake.close());
  const calls = [];
  const ai = { reply: async (a) => (calls.push(a), 'tamam') };
  const engine = new Engine({ store, clientFactory: (tk) => new InstagramClient(tk, { baseUrl: fake.url }), random: () => 0, ai });
  acc.persona = { about: 'DJ', examples: [] };
  store.saveRule({ name: 'AI', accountId: acc.id, type: 'dm', keywords: '', replyMode: 'ai', oncePerUser: false });
  fake.addMessage('dj_engine', { username: 'm', text: 'selam', at: Date.now() - 2000 });
  await engine.tick();
  fake.addMessage('dj_engine', { username: 'm', text: 'fiyat ne?' });
  await engine.tick();
  const last = calls.at(-1);
  assert.equal(last.persona.about, 'DJ');
  assert.equal(last.incoming, 'fiyat ne?');
  assert.deepEqual(last.history, [{ me: false, text: 'selam' }, { me: true, text: 'tamam' }]);
});

test('DM\'lerdeki gerçek cevaplarım örnek olarak toplanır', async (t) => {
  const { fake, acc } = await setup();
  t.after(() => fake.close());
  const c = new InstagramClient(acc.token, { baseUrl: fake.url });
  fake.addMessage('dj_engine', { username: 'a', text: 'set ne zaman?', at: Date.now() - 5000 });
  await c.sendMessage('u-a', 'Cuma akşamı 22:00 🎧');
  fake.addMessage('dj_engine', { username: 'b', text: 'cevap yok' });
  assert.deepEqual(await c.myReplies(), [{ in: 'set ne zaman?', out: 'Cuma akşamı 22:00 🎧' }]);
});

test('hesap sahibi bir mesaja zaten bizzat cevap verdiyse otomatik cevap gönderilmez', async (t) => {
  const { fake, store, engine, acc } = await setup();
  t.after(() => fake.close());
  store.saveRule({ name: 'Herkese', accountId: acc.id, type: 'dm', keywords: '', dmText: 'otomatik', oncePerUser: false });
  fake.addMessage('dj_engine', { username: 'x', text: 'soru', at: Date.now() - 3000 });
  fake.ownReply('dj_engine', 'u-x', 'ben cevapladım');
  await engine.tick();
  assert.equal(fake.state.sent.length, 0);
  // Aynı milisaniyede gelen mesaj + benim cevabım da doğru sırada değerlendirilir
  const now = Date.now();
  fake.addMessage('dj_engine', { username: 'y', text: 'soru', at: now });
  fake.ownReply('dj_engine', 'u-y', 'cevapladım');
  await engine.tick();
  assert.equal(fake.state.sent.length, 0);
  // Sonra yeni bir mesaj gelirse ona cevap verilir
  fake.addMessage('dj_engine', { username: 'x', text: 'teşekkürler' });
  await engine.tick();
  assert.deepEqual(fake.state.sent.map((s) => s.text), ['otomatik']);
});
