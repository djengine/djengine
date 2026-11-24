'use strict';
// Uçtan uca test: gerçek Electron uygulamasını açar, sahte Instagram sunucusuna karşı
// bir kullanıcının yapacağı her adımı arayüzden tıklayarak dener.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { createFakeInstagram } = require('../fake-instagram');
const { createFakeOllama } = require('../fake-ollama');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.DMO_SHOTS || path.join(os.tmpdir(), 'dmo-shots');
const U1 = 'dj_engine';
const U2 = 'gsridercyprus';

let OLLAMA_URL = '';
const EXPORT_PATH = path.join(os.tmpdir(), `dmo-kisiler-${process.pid}.csv`);

function launch(userData, fakeUrl) {
  const args = [ROOT];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  return electron.launch({
    args,
    env: { ...process.env, IG_WEB_BASE: fakeUrl, DMO_USER_DATA: userData, OLLAMA_URL, DMO_EXPORT_PATH: EXPORT_PATH },
    executablePath: process.env.DMO_APP_EXECUTABLE || require('electron'),
  });
}

const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Zaman aşımı');
};

test('uygulama uçtan uca çalışır', { timeout: 120000 }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const fake = createFakeInstagram();
  await fake.listen();
  fake.addAccount(U1, 'dj-sifre');
  fake.addAccount(U2, 'gs-sifre');
  const post = fake.addMedia(U1, 'Yeni set yayında 🎧');
  fake.addMedia(U1, 'Cuma gecesi');
  const ollama = createFakeOllama();
  OLLAMA_URL = await ollama.listen();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dmo-e2e-'));

  let app = null;
  t.after(async () => {
    try { if (app) await app.close(); } catch (_) {}
    await fake.close();
    await ollama.close();
  });
  app = await launch(userData, fake.url);
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1120, height: 760 }).catch(() => {});

  await t.test('açılışta genel bakış ve test modu uyarısı görünür', async () => {
    await page.getByRole('heading', { name: 'Genel Bakış' }).waitFor();
    assert.ok(await page.locator('#dry-banner').isVisible());
    await page.screenshot({ path: path.join(SHOTS, '01-ilk-acilis.png') });
  });

  const loginWith = async (username, password) => {
    await page.fill('[data-testid="ig-username"]', username);
    await page.fill('[data-testid="ig-password"]', password);
    await page.click('[data-testid="login"]');
  };
  const visibleLoginWindow = async () => {
    let w = null;
    await waitFor(async () => {
      for (const p of app.windows()) {
        if (p === page || p.isClosed()) continue;
        const vis = await app.evaluate(({ BrowserWindow }, url) => {
          const bw = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url);
          return !!bw && bw.isVisible();
        }, p.url()).catch(() => false);
        if (vis) w = p;
      }
      return !!w;
    }, 10000);
    return w;
  };

  await t.test('e-posta yazılırsa kullanıcı adı istenir, token alanı yoktur', async () => {
    await page.click('[data-view="accounts"]');
    assert.equal(await page.locator('textarea, [data-testid="token-input"]').count(), 0);
    assert.doesNotMatch(await page.locator('#view-accounts').textContent(), /token|e-posta/i);
    await loginWith('dj@ornek.com', 'x');
    await page.locator('#toast.err').waitFor();
    assert.match(await page.locator('#toast').textContent(), /kullanıcı adı/i);
    assert.equal(app.windows().length, 1, 'e-postayla giriş penceresi açılmamalı');
  });

  await t.test('yanlış şifrede Instagram penceresi gösterilir, kapatılınca anlaşılır mesaj verilir', async () => {
    await loginWith(U1, 'yanlis');
    const w = await visibleLoginWindow();
    await w.locator('#err').waitFor();
    await w.close();
    await page.locator('#toast.err').waitFor();
    assert.match(await page.locator('#toast').textContent(), /giriş tamamlanmadı/i);
  });

  await t.test('iki hesap kullanıcı adı ve şifreyle, ek pencere görmeden bağlanır', async () => {
    // Gerçek Instagram girişten hemen sonraki profil isteğine 429 dönebiliyor; giriş yine de tamamlanmalı
    fake.state.rateLimitProfile = true;
    for (const [name, pass] of [[U1, 'dj-sifre'], ['@' + U2, 'gs-sifre']]) {
      await loginWith(name, pass);
      await page.locator(`[data-testid="account-${name.replace('@', '')}"]`).waitFor();
    }
    const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length);
    assert.equal(shown, 1, 'başarılı girişte Instagram penceresi görünmemeli');
    assert.equal(await page.locator('[data-testid="ig-password"]').inputValue(), '');
    fake.state.rateLimitProfile = false;
    await page.screenshot({ path: path.join(SHOTS, '02-hesaplar.png') });
  });

  await t.test('yorum otomasyonu seçili gönderiyle oluşturulur', async () => {
    await page.click('[data-view="rules"]');
    await page.click('[data-testid="new-rule"]');
    await page.fill('[data-testid="rule-name"]', 'Set linki');
    await page.selectOption('[data-testid="rule-account"]', { label: '@dj_engine' });
    await page.fill('[data-testid="rule-keywords"]', 'set, link');
    await page.check('input[name="mediaScope"][value="selected"]');
    await page.locator(`[data-media="${post.id}"]`).click();
    await page.fill('[data-testid="rule-dm"]', 'Selam {username}! Set linki: https://example.com/set');
    await page.check('input[name="publicReplyEnabled"]');
    await page.fill('textarea[name="publicReplyText"]', "DM'ini kontrol et 🔥");
    await page.screenshot({ path: path.join(SHOTS, '03-otomasyon-duzenleyici.png') });
    await page.click('[data-testid="rule-save"]');
    await page.locator('[data-testid="rule-Set linki"]').waitFor();
  });

  await t.test('eksik bilgiyle kural kaydedilmez', async () => {
    await page.click('[data-testid="new-rule"]');
    await page.click('[data-testid="rule-save"]');
    assert.match(await page.locator('#rule-error').textContent(), /isim/);
    await page.click('#rule-cancel');
  });

  await t.test('DM otomasyonu ikinci hesaba oluşturulur', async () => {
    await page.click('[data-testid="new-rule"]');
    await page.fill('[data-testid="rule-name"]', 'Kiralama fiyatı');
    await page.selectOption('[data-testid="rule-account"]', { label: '@gsridercyprus' });
    await page.check('[data-testid="type-dm"]');
    await page.fill('[data-testid="rule-keywords"]', 'fiyat, kiralama');
    await page.fill('[data-testid="rule-dm"]', 'Merhaba! Fiyat listemiz: https://example.com/fiyat');
    await page.click('[data-testid="rule-save"]');
    await page.locator('[data-testid="rule-Kiralama fiyatı"]').waitFor();
    await page.screenshot({ path: path.join(SHOTS, '04-otomasyonlar.png') });
  });

  await t.test('test modunda mesaj gönderilmez, kaydı tutulur', async () => {
    fake.addComment(U1, post.id, { username: 'dinleyici1', text: 'SET linki lütfen' });
    await page.click('[data-view="overview"]');
    await page.click('[data-testid="check-now"]');
    await page.click('[data-view="activity"]');
    await page.locator('#view-activity [data-testid="log-dry"]').first().waitFor();
    assert.equal(fake.state.sent.length, 0);
  });

  await t.test('test modu kapatılınca gerçek gönderim yapılır', async () => {
    await page.click('[data-testid="dry-off"]');
    await waitFor(async () => !(await page.locator('#dry-banner').isVisible()));
    fake.addComment(U1, post.id, { username: 'dinleyici2', text: 'link atar mısın' });
    fake.addComment(U1, post.id, { username: 'dinleyici3', text: 'süper olmuş' });
    fake.addMessage(U2, { username: 'turist', text: 'Motor kiralama fiyatı nedir?' });
    await page.click('[data-view="overview"]');
    await page.click('[data-testid="check-now"]');
    await waitFor(() => fake.state.sent.length >= 3);
    assert.ok(fake.state.rurSeen > 0, 'istekler tarayıcı oturumundan gitmeli (Instagram\'ın yenilediği çerezler geri gönderilmeli)');
    const kinds = fake.state.sent.map((s) => `${s.kind}:${s.to || ''}`).sort();
    assert.deepEqual(kinds, ['dm:u-dinleyici2', 'dm:u-turist', 'public_reply:']);
    const pr = fake.state.sent.find((s) => s.to === 'u-dinleyici2');
    assert.equal(pr.text, 'Selam @dinleyici2! Set linki: https://example.com/set');
    await waitFor(async () => (await page.locator('[data-testid="stat-sent"]').textContent()) === '2');
    await page.screenshot({ path: path.join(SHOTS, '05-genel-bakis.png') });
    await page.click('[data-view="activity"]');
    await page.screenshot({ path: path.join(SHOTS, '06-aktivite.png') });
  });

  await t.test('otomasyon kapatılınca çalışmaz', async () => {
    await page.click('[data-view="rules"]');
    await page.locator('[data-testid="rule-Set linki"] .switch').click();
    await waitFor(async () => {
      const s = await page.evaluate(() => window.api.state());
      return s.rules.find((r) => r.name === 'Set linki').active === false;
    });
    fake.addComment(U1, post.id, { username: 'dinleyici4', text: 'set' });
    await page.evaluate(() => window.api.checkNow());
    assert.equal(fake.state.sent.length, 3);
  });

  await t.test('takip şartlı hikâye otomasyonu: önce takip istenir, takip edince asıl mesaj gider', async () => {
    await page.click('[data-view="rules"]');
    await page.click('[data-testid="new-rule"]');
    await page.fill('[data-testid="rule-name"]', 'Bilet');
    await page.selectOption('[data-testid="rule-account"]', { label: '@dj_engine' });
    await page.check('[data-testid="type-story"]');
    assert.ok(await page.locator('#media-section').isHidden(), 'hikâyede gönderi seçimi görünmemeli');
    await page.fill('[data-testid="rule-keywords"]', 'bilet');
    await page.fill('[data-testid="rule-dm"]', 'Bilet linki: https://example.com/bilet');
    await page.check('[data-testid="rule-gate"]');
    await page.fill('[data-testid="rule-gate-text"]', 'Önce takip et {username} 🙌');
    await page.screenshot({ path: path.join(SHOTS, '09-takip-sartli-hikaye.png') });
    await page.click('[data-testid="rule-save"]');
    await page.locator('[data-testid="rule-Bilet"]').waitFor();

    const before = fake.state.sent.length;
    fake.addMessage(U1, { username: 'fan', text: 'bilet nereden alınır?', story: true });
    await page.evaluate(() => window.api.checkNow());
    await waitFor(() => fake.state.sent.length === before + 1);
    assert.equal(fake.state.sent.at(-1).text, 'Önce takip et @fan 🙌');

    fake.follow(U1, 'u-fan');
    fake.addMessage(U1, { username: 'fan', text: 'takip ettim' });
    await page.evaluate(() => window.api.checkNow());
    await waitFor(() => fake.state.sent.length === before + 2);
    assert.equal(fake.state.sent.at(-1).text, 'Bilet linki: https://example.com/bilet');
    await waitFor(async () => (await page.locator('[data-testid="st-unlocked-Bilet"]').textContent()) === '1');
    assert.equal(await page.locator('[data-testid="st-gated-Bilet"]').textContent(), '1');
    await page.screenshot({ path: path.join(SHOTS, '10-otomasyon-istatistik.png') });
  });

  await t.test('tarih kapsamında tarih seçilmeden kaydedilmez', async () => {
    await page.click('[data-testid="new-rule"]');
    await page.fill('[data-testid="rule-name"]', 'Tarihli');
    await page.check('[data-testid="scope-since"]');
    assert.ok(await page.locator('[data-testid="rule-since"]').isVisible());
    await page.fill('[data-testid="rule-dm"]', 'x');
    await page.click('[data-testid="rule-save"]');
    assert.match(await page.locator('#rule-error').textContent(), /tarih/i);
    await page.click('#rule-cancel');
  });

  await t.test('DM\'de verilen e-posta kişilere kaydedilir ve Excel\'e aktarılır', async () => {
    fake.addMessage(U2, { username: 'otel', text: 'kiralama fiyatı? mailim rezervasyon@otel.com' });
    await page.evaluate(() => window.api.checkNow());
    await page.click('[data-view="contacts"]');
    await page.locator('[data-testid="contact-otel"]').waitFor();
    assert.match(await page.locator('[data-testid="contact-otel"]').textContent(), /rezervasyon@otel\.com/);
    await page.fill('[data-testid="contact-search"]', 'otel');
    assert.equal(await page.locator('[data-testid^="contact-"][data-testid$="fan"]').count(), 0);
    await page.screenshot({ path: path.join(SHOTS, '11-kisiler.png') });
    await page.click('[data-testid="export-contacts"]');
    await waitFor(() => fs.existsSync(EXPORT_PATH));
    const csv = fs.readFileSync(EXPORT_PATH, 'utf8');
    assert.ok(csv.startsWith('﻿'), 'Excel için BOM olmalı');
    assert.match(csv, /"otel";"gsridercyprus";"rezervasyon@otel\.com"/);
    await page.fill('[data-testid="contact-search"]', '');
  });

  await t.test('yapay zekâ: model indirilir, asistan hesabı analiz eder', async () => {
    await page.click('[data-view="ai"]');
    await page.locator('[data-testid="ai-pull"]').waitFor();
    await page.screenshot({ path: path.join(SHOTS, '12-yapay-zeka-kurulum.png') });
    await page.click('[data-testid="ai-pull"]');
    await page.locator('[data-testid="ai-ready"]').waitFor({ timeout: 15000 });
    await page.selectOption('[data-testid="ai-account"]', { label: '@dj_engine' });
    await page.getByRole('button', { name: '📊 Hesabımı analiz et' }).click();
    await page.locator('[data-testid="ai-msg-assistant"]').waitFor({ timeout: 15000 });
    assert.match(await page.locator('[data-testid="ai-msg-assistant"]').textContent(), /Analiz/);
    const sys = ollama.state.chats.at(-1).messages[0].content;
    assert.match(sys, /Hesap: @dj_engine/);
    assert.match(sys, /Takipçi: 12\d\d/);
    assert.match(sys, /Yeni set yayında/);
    await page.screenshot({ path: path.join(SHOTS, '13-yapay-zeka-asistan.png') });
  });

  await t.test('yapay zekâ eğitilir: Beni tanı, DM\'lerden öğren, dene-onayla-düzelt', async () => {
    // Test modu açıkken otomatik pilot kartı uyarır
    await page.evaluate(() => window.api.updateSettings({ dryRun: true }));
    await page.locator('[data-testid="pilot-dry-warning"]').waitFor();
    await page.evaluate(() => window.api.updateSettings({ dryRun: false }));
    await page.locator('[data-testid="pilot-dry-warning"]').waitFor({ state: 'detached' });

    await page.fill('[data-testid="persona-about"]', 'DJ Engine, düğün DJ\'i');
    await page.fill('[data-testid="persona-info"]', 'Düğün paketi 15.000 TL');
    await page.selectOption('[data-testid="persona-address"]', 'sen');
    await page.fill('[data-testid="persona-never"]', 'İndirim sözü verme');
    await page.click('[data-testid="persona-save"]');
    await waitFor(async () => {
      const s = await page.evaluate(() => window.api.state());
      const p = s.accounts.find((a) => a.username === 'dj_engine').persona || {};
      return p.about === 'DJ Engine, düğün DJ\'i' && p.address === 'sen' && p.never === 'İndirim sözü verme';
    });

    // Instagram'da bizzat verdiğim bir cevap örnek olarak öğrenilir; uygulamanın otomatik cevapları öğrenilmez
    fake.addMessage(U1, { username: 'soran', text: 'set listesi paylaşır mısın?' });
    fake.ownReply(U1, 'u-soran', 'Tabii kanka, yarın story\'de 🎧');
    await page.click('[data-testid="learn-dms"]');
    await waitFor(async () => (await page.locator('[data-testid="example"]').count()) === 1);
    assert.match(await page.locator('[data-testid="example"]').textContent(), /yarın story'de/);

    // Dene → onayla
    await page.fill('[data-testid="try-text"]', 'fiyat alabilir miyim?');
    await page.click('[data-testid="try-send"]');
    await page.locator('[data-testid="try-reply"]').waitFor({ timeout: 15000 });
    const sys = ollama.state.chats.at(-1).messages[0].content;
    assert.match(sys, /DJ Engine, düğün DJ'i/);
    assert.match(sys, /"sen" diye hitap/);
    assert.match(ollama.state.chats.at(-1).messages[1].content, /set listesi paylaşır mısın\?/);
    await page.click('[data-testid="try-good"]');
    await waitFor(async () => (await page.locator('[data-testid="example"]').count()) === 2);

    // Dene → düzelt
    await page.fill('[data-testid="try-text"]', 'kapora ne kadar?');
    await page.click('[data-testid="try-send"]');
    await page.locator('[data-testid="try-edit"]').click();
    await page.fill('[data-testid="try-fix"]', 'Kapora %30, kalanı düğün günü 🙌');
    await page.click('[data-testid="try-fix-save"]');
    await waitFor(async () => (await page.locator('[data-testid="example"]').count()) === 3);
    assert.match(await page.locator('.examples').textContent(), /Kapora %30, kalanı düğün günü/);
    await page.screenshot({ path: path.join(SHOTS, '14-yapay-zekayi-egit.png'), fullPage: true });
  });

  await t.test('otomatik pilot: DM\'lere yapay zekâ cevap verir', async () => {
    await page.fill('[data-testid="pilot-text"]', 'DJ hizmeti. Fiyat için tarih sor.');
    await page.locator('label:has([data-testid="pilot-on"])').click();
    await waitFor(async () => {
      const s = await page.evaluate(() => window.api.state());
      return s.rules.some((r) => r.autopilot && r.active && r.aiInstructions === 'DJ hizmeti. Fiyat için tarih sor.');
    });
    const before = fake.state.sent.length;
    fake.addMessage(U1, { username: 'gelin', text: 'düğün için müsait misiniz?', pending: true });
    await page.evaluate(() => window.api.checkNow());
    await waitFor(() => fake.state.sent.length === before + 1, 15000);
    assert.equal(fake.state.sent.at(-1).text, 'Merhaba! Bilgileri hemen gönderiyorum 🙌');
    assert.equal(fake.state.sent.at(-1).to, 'u-gelin');
    assert.equal(fake.state.approved, 1, 'mesaj isteği cevaplanmadan önce kabul edilmeli');
    assert.match(ollama.state.chats.at(-1).messages[0].content, /DJ Engine, düğün DJ'i/);
    const reply = ollama.state.chats.at(-1).messages.at(-1).content;
    assert.match(reply, /DJ hizmeti\. Fiyat için tarih sor\./);
    assert.match(reply, /<gelen_mesaj>\ndüğün için müsait misiniz\?/);
    await page.locator('label:has([data-testid="pilot-on"])').click();
    await waitFor(async () => !(await page.evaluate(() => window.api.state())).rules.find((r) => r.autopilot).active);
  });

  await t.test('oturum kapanınca "Yeniden giriş yap" ile tek tıkla düzelir', async () => {
    fake.expireSession(U2);
    await page.evaluate(() => window.api.checkNow());
    await page.click('[data-view="accounts"]');
    const btn = `[data-testid="relogin-${U2}"]`;
    await page.click(btn);
    assert.equal(await page.locator('[data-testid="ig-username"]').inputValue(), U2);
    await page.fill('[data-testid="ig-password"]', 'gs-sifre');
    await page.click('[data-testid="login"]');
    await page.locator(btn).waitFor({ state: 'detached' });
    const s = await page.evaluate(() => window.api.state());
    assert.equal(s.accounts.length, 2);
    assert.equal(s.accounts.find((a) => a.username === U2).status, 'ok');
  });

  await t.test('ayarlar ve rehber sayfaları açılır', async () => {
    await page.click('[data-view="settings"]');
    await page.getByRole('heading', { name: 'Ayarlar' }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, '07-ayarlar.png') });
    await page.click('[data-view="help"]');
    await page.getByRole('heading', { name: 'Kurulum Rehberi' }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, '08-rehber.png') });
  });

  await t.test('pencere kapatılınca uygulama arka planda çalışmaya devam eder', async () => {
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
    assert.equal(before, 1);
    assert.equal(visible, false);
  });

  await t.test('yeniden açılınca veriler korunur, oturum bilgisi düz metin olarak saklanmaz', async () => {
    await app.evaluate(({ app: a }) => a.quit());
    await waitFor(async () => {
      try { return !app.process() || app.process().exitCode !== null; } catch (_) { return true; }
    }, 10000).catch(() => {});
    const raw = fs.readFileSync(path.join(userData, 'data.json'), 'utf8');
    assert.ok(!raw.includes('sessionid=') || process.platform === 'linux', 'Mac\'te oturum bilgisi şifreli olmalı');
    // Linux'ta Anahtar Zinciri yok, kayıt okunabilir: Instagram'ın yenilediği çerez kayda geri yazılmış olmalı
    if (process.platform === 'linux') assert.match(raw, /rur=R\d+/);
    app = await launch(userData, fake.url);
    const p2 = await app.firstWindow();
    const s = await p2.evaluate(() => window.api.state());
    assert.deepEqual(s.accounts.map((a) => a.username).sort(), ['dj_engine', 'gsridercyprus']);
    assert.equal(s.rules.length, 4);
    assert.equal(s.settings.dryRun, false);
  });

  assert.deepEqual(errors, [], 'Arayüzde JavaScript hatası olmamalı');
});
