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
const U1 = 'dj_engine';
const U2 = 'gsridercyprus';

function launch(userData, fakeUrl) {
  const args = [ROOT];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  return electron.launch({
    args,
    env: { ...process.env, IG_WEB_BASE: fakeUrl, DMO_USER_DATA: userData },
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
    for (const [name, pass] of [[U1, 'dj-sifre'], ['@' + U2, 'gs-sifre']]) {
      await loginWith(name, pass);
      await page.locator(`[data-testid="account-${name.replace('@', '')}"]`).waitFor();
    }
    const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length);
    assert.equal(shown, 1, 'başarılı girişte Instagram penceresi görünmemeli');
    assert.equal(await page.locator('[data-testid="ig-password"]').inputValue(), '');
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
    app = await launch(userData, fake.url);
    const p2 = await app.firstWindow();
    const s = await p2.evaluate(() => window.api.state());
    assert.deepEqual(s.accounts.map((a) => a.username).sort(), ['dj_engine', 'gsridercyprus']);
    assert.equal(s.rules.length, 2);
    assert.equal(s.settings.dryRun, false);
  });

  assert.deepEqual(errors, [], 'Arayüzde JavaScript hatası olmamalı');
});
