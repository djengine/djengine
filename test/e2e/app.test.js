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

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.DMO_SHOTS || path.join(os.tmpdir(), 'dmo-shots');
const TOKEN1 = 'IGAAtest-dj-engine-0123456789abcdef';
const TOKEN2 = 'IGAAtest-gsridercyprus-0123456789abcdef';

function launch(userData, fakeUrl) {
  const args = [ROOT];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  return electron.launch({
    args,
    env: { ...process.env, IG_API_BASE: fakeUrl, DMO_USER_DATA: userData },
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
  fake.addAccount(TOKEN1, 'dj_engine');
  fake.addAccount(TOKEN2, 'gsridercyprus');
  const post = fake.addMedia(TOKEN1, 'Yeni set yayında 🎧');
  fake.addMedia(TOKEN1, 'Cuma gecesi');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dmo-e2e-'));

  let app = null;
  t.after(async () => {
    try { if (app) await app.close(); } catch (_) {}
    await fake.close();
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

  await t.test('hatalı token anlaşılır hata verir', async () => {
    await page.click('[data-view="accounts"]');
    await page.fill('[data-testid="token-input"]', 'IGAA-yanlis-token-00000000000');
    await page.click('[data-testid="connect"]');
    await page.locator('#toast.err').waitFor();
    assert.match(await page.locator('#toast').textContent(), /token/i);
  });

  await t.test('iki hesap bağlanır', async () => {
    for (const [tok, name] of [[TOKEN1, 'dj_engine'], [TOKEN2, 'gsridercyprus']]) {
      await page.fill('[data-testid="token-input"]', tok);
      await page.click('[data-testid="connect"]');
      await page.locator(`[data-testid="account-${name}"]`).waitFor();
    }
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
    fake.addComment(TOKEN1, post.id, { username: 'dinleyici1', text: 'SET linki lütfen' });
    await page.click('[data-view="overview"]');
    await page.click('[data-testid="check-now"]');
    await page.click('[data-view="activity"]');
    await page.locator('#view-activity [data-testid="log-dry"]').first().waitFor();
    assert.equal(fake.state.sent.length, 0);
  });

  await t.test('test modu kapatılınca gerçek gönderim yapılır', async () => {
    await page.click('[data-testid="dry-off"]');
    await waitFor(async () => !(await page.locator('#dry-banner').isVisible()));
    fake.addComment(TOKEN1, post.id, { username: 'dinleyici2', text: 'link atar mısın' });
    fake.addComment(TOKEN1, post.id, { username: 'dinleyici3', text: 'süper olmuş' });
    fake.addMessage(TOKEN2, { username: 'turist', text: 'Motor kiralama fiyatı nedir?' });
    await page.click('[data-view="overview"]');
    await page.click('[data-testid="check-now"]');
    await waitFor(() => fake.state.sent.length >= 3);
    const kinds = fake.state.sent.map((s) => `${s.kind}:${s.to || ''}`).sort();
    assert.deepEqual(kinds, ['dm:u-turist', 'private_reply:dinleyici2', 'public_reply:']);
    const pr = fake.state.sent.find((s) => s.kind === 'private_reply');
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
    fake.addComment(TOKEN1, post.id, { username: 'dinleyici4', text: 'set' });
    await page.evaluate(() => window.api.checkNow());
    assert.equal(fake.state.sent.length, 3);
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

  await t.test('yeniden açılınca veriler korunur, token düz metin olarak saklanmaz', async () => {
    await app.evaluate(({ app: a }) => a.quit());
    await waitFor(async () => {
      try { return !app.process() || app.process().exitCode !== null; } catch (_) { return true; }
    }, 10000).catch(() => {});
    const raw = fs.readFileSync(path.join(userData, 'data.json'), 'utf8');
    assert.ok(!raw.includes(TOKEN1) || process.platform === 'linux', 'Mac\'te token şifreli olmalı');
    app = await launch(userData, fake.url);
    const p2 = await app.firstWindow();
    const s = await p2.evaluate(() => window.api.state());
    assert.deepEqual(s.accounts.map((a) => a.username).sort(), ['dj_engine', 'gsridercyprus']);
    assert.equal(s.rules.length, 2);
    assert.equal(s.settings.dryRun, false);
  });

  assert.deepEqual(errors, [], 'Arayüzde JavaScript hatası olmamalı');
});
