'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerSaveBlocker, safeStorage, shell, Notification, session } = require('electron');
const { Store } = require('./core/store');
const { Engine } = require('./core/engine');
const { InstagramClient, USER_AGENT } = require('./core/instagram');

if (process.env.DMO_USER_DATA) app.setPath('userData', process.env.DMO_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let store = null;
let engine = null;
let timer = null;
let nextTickAt = null;
let blockerId = null;
let quitting = false;

// ---- Oturum şifreleme (macOS'ta Anahtar Zinciri) ----
function encrypt(s) {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(s).toString('base64')}`;
  return `plain:${s}`;
}
function decrypt(s) {
  if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  if (s.startsWith('plain:')) return s.slice(6);
  return s;
}

// ---- Zamanlayıcı ----
function schedule(delayMs) {
  clearTimeout(timer);
  if (!store.settings.running) {
    nextTickAt = null;
    updatePowerBlocker();
    return;
  }
  const delay = delayMs != null ? delayMs : Math.max(30, Number(store.settings.pollSeconds) || 60) * 1000;
  nextTickAt = Date.now() + delay;
  timer = setTimeout(runTick, delay);
  updatePowerBlocker();
}

async function runTick() {
  const before = store.data.log.length ? store.data.log[0].id : null;
  try {
    await engine.tick();
  } catch (e) {
    store.addLog({ type: 'error', message: `Beklenmeyen hata: ${e.message}` });
    store.save();
  }
  notifyNewSends(before);
  schedule();
  pushState();
}

function notifyNewSends(prevTopId) {
  if (!Notification.isSupported() || !store.settings.notifications) return;
  const fresh = [];
  for (const l of store.data.log) {
    if (l.id === prevTopId) break;
    if (l.type === 'sent') fresh.push(l);
  }
  if (fresh.length) {
    new Notification({
      title: 'DM Otomasyon',
      body: fresh.length === 1 ? `@${fresh[0].user} kişisine mesaj gönderildi (${fresh[0].account})` : `${fresh.length} otomatik mesaj gönderildi`,
      silent: true,
    }).show();
  }
}

function updatePowerBlocker() {
  // Uygulama arka plandayken macOS'un onu uyutmasını (App Nap) engeller
  const want = store.settings.running;
  if (want && blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blockerId != null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

// ---- Arayüze gönderilen durum ----
function publicState() {
  const d = store.data;
  return {
    settings: d.settings,
    accounts: d.accounts.map(({ token, ...a }) => ({ ...a, hasToken: !!token })),
    rules: d.rules,
    log: d.log.slice(0, 300),
    engine: { busy: engine.busy, lastTickAt: engine.lastTickAt, nextTickAt },
    encryption: safeStorage.isEncryptionAvailable(),
    version: app.getVersion(),
  };
}

let pushPending = false;
function pushState() {
  if (pushPending) return;
  pushPending = true;
  setImmediate(() => {
    pushPending = false;
    if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
    refreshTray();
  });
}

// ---- Instagram ile giriş ----
// Instagram'ın kendi giriş sayfasını ayrı, geçici bir oturumda açar. Kullanıcı adı/şifre ve
// varsa doğrulama kodu bu sayfada girilir; şifre uygulamaya hiç gelmez ve saklanmaz.
// Giriş tamamlanınca oturum çerezleri alınır ve pencere kapanır.
let loginWin = null;
function loginWithInstagram() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return Promise.reject(new Error('Giriş penceresi zaten açık.'));
  }
  const base = (process.env.IG_WEB_BASE || 'https://www.instagram.com').replace(/\/$/, '');
  const partition = `dmo-login-${Date.now()}`; // kalıcı değil: her giriş temiz başlar
  const ses = session.fromPartition(partition);
  ses.setUserAgent(USER_AGENT);
  return new Promise((resolve, reject) => {
    let done = false;
    const w = (loginWin = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Instagram ile Giriş',
      parent: win && !win.isDestroyed() ? win : undefined,
      backgroundColor: '#ffffff',
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    }));
    w.webContents.setWindowOpenHandler(({ url }) => {
      w.loadURL(url);
      return { action: 'deny' };
    });
    const finish = async () => {
      if (done) return;
      const cookies = await ses.cookies.get({ url: base });
      const has = (n) => cookies.some((c) => c.name === n && c.value);
      if (!has('sessionid') || !has('ds_user_id')) return;
      done = true;
      clearInterval(iv);
      resolve(cookies.map((c) => `${c.name}=${c.value}`).join('; '));
      w.destroy();
      ses.clearStorageData().catch(() => {});
    };
    const iv = setInterval(() => finish().catch(() => {}), 600);
    w.on('closed', () => {
      clearInterval(iv);
      loginWin = null;
      if (!done) reject(new Error('Giriş tamamlanmadı (pencere kapatıldı).'));
    });
    w.loadURL(`${base}/accounts/login/`).catch(() => {});
  });
}

// ---- IPC ----
function registerIpc() {
  const handle = (name, fn) =>
    ipcMain.handle(name, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    });

  handle('state', () => publicState());

  handle('account:login', async () => {
    const cookies = await loginWithInstagram();
    const me = await new InstagramClient(cookies).me();
    if (!me.user_id || !me.username) throw new Error('Hesap bilgisi alınamadı, lütfen tekrar deneyin.');
    const now = new Date().toISOString();
    const acc = store.upsertAccount({
      igUserId: String(me.user_id),
      username: me.username,
      name: me.name || '',
      picture: me.profile_picture_url || '',
      accountType: me.account_type || '',
      token: cookies,
      connectedAt: now,
      status: 'ok',
      lastError: null,
      backoffUntil: null,
    });
    store.addLog({ type: 'info', accountId: acc.id, account: acc.username, message: 'Instagram ile giriş yapıldı.' });
    store.save();
    return { id: acc.id, username: acc.username };
  });

  handle('account:remove', (id) => store.removeAccount(id));

  handle('account:media', async (id) => {
    const acc = store.getAccount(id);
    if (!acc || !acc.token) throw new Error('Hesap bulunamadı.');
    return new InstagramClient(acc.token).recentMedia(30);
  });

  handle('rule:save', (rule) => {
    if (!rule.name || !rule.name.trim()) throw new Error('Kurala bir isim verin.');
    if (!store.getAccount(rule.accountId)) throw new Error('Bir hesap seçin.');
    if (!['comment', 'dm'].includes(rule.type)) throw new Error('Tetikleyici türü geçersiz.');
    if (!rule.dmText || !rule.dmText.trim()) throw new Error('Gönderilecek DM mesajını yazın.');
    if (rule.type === 'comment' && rule.mediaScope === 'selected' && !(rule.mediaIds || []).length)
      throw new Error('En az bir gönderi seçin ya da "Tüm son gönderiler" seçeneğini kullanın.');
    if (rule.publicReplyEnabled && !String(rule.publicReplyText || '').trim())
      throw new Error('Yoruma yazılacak cevabı girin ya da bu seçeneği kapatın.');
    return store.saveRule(rule);
  });

  handle('rule:remove', (id) => store.removeRule(id));

  handle('settings:update', (patch) => {
    const allowed = ['pollSeconds', 'recentPosts', 'maxSendsPerHour', 'dryRun', 'running', 'openAtLogin', 'notifications'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if ('pollSeconds' in clean) clean.pollSeconds = Math.min(600, Math.max(30, Number(clean.pollSeconds) || 60));
    if ('recentPosts' in clean) clean.recentPosts = Math.min(25, Math.max(1, Number(clean.recentPosts) || 10));
    if ('maxSendsPerHour' in clean) clean.maxSendsPerHour = Math.min(200, Math.max(1, Number(clean.maxSendsPerHour) || 40));
    store.updateSettings(clean);
    if ('openAtLogin' in clean && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!clean.openAtLogin, openAsHidden: true });
    if ('running' in clean || 'pollSeconds' in clean) schedule(clean.running ? 1000 : undefined);
    return store.settings;
  });

  handle('check:now', async () => {
    clearTimeout(timer);
    await runTick();
  });

  handle('log:clear', () => store.clearLog());

  handle('open:external', (url) => {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && /(^|\.)(instagram\.com|facebook\.com|meta\.com)$/.test(u.hostname);
    if (!ok) throw new Error('Bu bağlantı açılamaz.');
    return shell.openExternal(url);
  });
}

// ---- Pencere ve menü çubuğu ----
function createWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'DM Otomasyon',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.env.DMO_HIDDEN) win.show();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    // Pencere kapanınca uygulama menü çubuğunda çalışmaya devam eder
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function refreshTray() {
  if (!tray) return;
  const s = store.settings;
  const status = !s.running ? 'Duraklatıldı' : s.dryRun ? 'Test modunda çalışıyor' : 'Çalışıyor';
  const today = new Date().toDateString();
  const sentToday = store.data.log.filter((l) => l.type === 'sent' && new Date(l.at).toDateString() === today).length;
  tray.setToolTip(`DM Otomasyon — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Durum: ${status}`, enabled: false },
      { label: `Bugün gönderilen: ${sentToday}`, enabled: false },
      { type: 'separator' },
      { label: 'Paneli Aç', click: createWindow },
      { label: 'Şimdi Kontrol Et', enabled: s.running, click: () => { clearTimeout(timer); runTick(); } },
      {
        label: s.running ? 'Duraklat' : 'Devam Et',
        click: () => {
          store.updateSettings({ running: !s.running });
          schedule(s.running ? undefined : 1000);
          pushState();
        },
      },
      { type: 'separator' },
      { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  refreshTray();
}

app.on('second-instance', () => createWindow());
app.on('activate', () => createWindow());
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', (e) => e.preventDefault && e.preventDefault());

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'data.json'), { encrypt, decrypt });
  if (store.settings.notifications == null) store.updateSettings({ notifications: true });
  engine = new Engine({ store });
  store.onChange(pushState);
  registerIpc();
  createTray();
  createWindow();
  schedule(3000);
});
