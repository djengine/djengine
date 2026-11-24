'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerSaveBlocker, safeStorage, shell, Notification, session, dialog } = require('electron');
const { Store } = require('./core/store');
const { Engine } = require('./core/engine');
const { InstagramClient, USER_AGENT, parseCookies } = require('./core/instagram');
const { AI, MODELS, DEFAULT_MODEL } = require('./core/ai');

if (process.env.DMO_USER_DATA) app.setPath('userData', process.env.DMO_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let store = null;
let engine = null;
let ai = null;
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
    await syncCookies();
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
    stats: d.stats,
    contacts: d.contacts.slice(0, 1000),
    contactsTotal: d.contacts.length,
    ai: { models: MODELS, model: d.settings.aiModel || DEFAULT_MODEL },
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
// Kullanıcı adı ve şifre uygulamadaki formdan alınır; Instagram'ın kendi giriş sayfası gizli,
// geçici bir oturumda açılıp bu bilgilerle otomatik doldurulur. Şifre sadece bu işlem için
// bellekte tutulur, hiçbir yere kaydedilmez. Instagram doğrulama kodu isterse veya şifre
// yanlışsa giriş penceresi kullanıcıya gösterilir. Giriş tamamlanınca oturum çerezleri alınır.
const LOGIN_SHOW_AFTER_MS = 12000;

// Instagram'ın giriş formunu doldurup gönderen, sayfada çalışan betik
function fillScript(username, password) {
  return `(async (u, p) => {
    const q = (s) => document.querySelector(s);
    const USER = 'input[name="username"], input[name="email"], input[autocomplete="username"]';
    const PASS = 'input[name="password"], input[name="pass"], input[type="password"]';
    for (let i = 0; i < 75 && !(q(USER) && q(PASS)); i++) await new Promise((r) => setTimeout(r, 200));
    const un = q(USER), pw = q(PASS);
    if (!un || !pw) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [el, v] of [[un, u], [pw, p]]) {
      el.focus();
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 400));
    const form = pw.form;
    const btn = (form && form.querySelector('button[type="submit"], button:not([type])')) || q('button[type="submit"]');
    if (btn) btn.click();
    else if (form) form.requestSubmit();
    return true;
  })(${JSON.stringify(username)}, ${JSON.stringify(password)})`;
}

let loginWin = null;
function loginWithInstagram({ username, password }) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    loginWin.focus();
    return Promise.reject(new Error('Giriş zaten sürüyor.'));
  }
  const base = (process.env.IG_WEB_BASE || 'https://www.instagram.com').replace(/\/$/, '');
  const loginUrl = `${base}/accounts/login/`;
  const partition = `dmo-login-${Date.now()}`; // kalıcı değil: her giriş temiz başlar
  const ses = session.fromPartition(partition);
  ses.setUserAgent(USER_AGENT);
  return new Promise((resolve, reject) => {
    let done = false;
    let filled = false;
    const w = (loginWin = new BrowserWindow({
      width: 480,
      height: 760,
      show: false,
      title: 'Instagram ile Giriş',
      parent: win && !win.isDestroyed() ? win : undefined,
      backgroundColor: '#ffffff',
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    }));
    const reveal = () => {
      if (!done && !w.isDestroyed() && !w.isVisible()) w.show();
    };
    w.webContents.setWindowOpenHandler(({ url }) => {
      w.loadURL(url);
      return { action: 'deny' };
    });
    w.webContents.on('did-finish-load', () => {
      const onLogin = w.webContents.getURL().startsWith(loginUrl);
      if (onLogin && !filled) {
        filled = true;
        w.webContents
          .executeJavaScript(fillScript(username, password))
          .then((ok) => !ok && reveal())
          .catch(reveal);
      } else if (filled) {
        // Giriş sayfası tekrar açıldı (yanlış şifre) ya da doğrulama sayfasına geçildi:
        // giriş birazdan tamamlanmazsa kullanıcıya göster.
        setTimeout(reveal, 1500);
      }
    });
    const showTimer = setTimeout(reveal, LOGIN_SHOW_AFTER_MS);
    const finish = async () => {
      if (done) return;
      const cookies = await ses.cookies.get({ url: base });
      const has = (n) => cookies.some((c) => c.name === n && c.value);
      if (!has('sessionid') || !has('ds_user_id')) return;
      done = true;
      clearInterval(iv);
      clearTimeout(showTimer);
      resolve(cookies.map((c) => `${c.name}=${c.value}`).join('; '));
      w.destroy();
      ses.clearStorageData().catch(() => {});
    };
    const iv = setInterval(() => finish().catch(() => {}), 500);
    w.on('closed', () => {
      clearInterval(iv);
      clearTimeout(showTimer);
      loginWin = null;
      if (!done) reject(new Error('Giriş tamamlanmadı. Kullanıcı adı ve şifrenizi kontrol edip tekrar deneyin.'));
    });
    w.loadURL(loginUrl).catch(() => {});
  });
}

// ---- Hesap başına tarayıcı oturumu ----
// Instagram'a giden tüm istekler, girişte kullanılan Chromium ağ katmanından gider: çerezler
// oturumda tutulur, Instagram'ın yenilediği çerezler otomatik saklanır ve istekler gerçek
// tarayıcıdan gelmiş görünür (Node'un kendi bağlantısı Instagram'da sık sık "429" alıyor).
const IG_BASE = () => (process.env.IG_WEB_BASE || 'https://www.instagram.com').replace(/\/$/, '');
const seeded = new Map(); // igUserId -> oturuma son yüklenen çerez metni

function igSession(igUserId) {
  const ses = session.fromPartition(`ig-${igUserId}`);
  ses.setUserAgent(USER_AGENT);
  return ses;
}

async function seedCookies(igUserId, cookieStr) {
  if (seeded.get(igUserId) === cookieStr) return;
  const ses = igSession(igUserId);
  await ses.clearStorageData({ storages: ['cookies'] });
  const url = IG_BASE();
  const secure = url.startsWith('https:');
  for (const part of String(cookieStr).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    await ses.cookies.set({ url, name, value, path: '/', secure, ...(secure ? { domain: '.instagram.com' } : {}) });
  }
  seeded.set(igUserId, cookieStr);
}

function clientFor(cookieStr, igUserId) {
  const ses = igSession(igUserId);
  let ready = null;
  const browserFetch = async (u, opts) => {
    ready = ready || seedCookies(igUserId, cookieStr);
    await ready;
    return ses.fetch(String(u), opts);
  };
  return new InstagramClient(cookieStr, { browserFetch });
}

// Instagram'ın yenilediği çerezleri (oturum süresini uzatır) şifreli kayda geri yaz
async function syncCookies() {
  let changed = false;
  for (const acc of store.data.accounts) {
    // Oturum bu kayıttaki çerezlerle yüklenmemişse (örn. arada yeniden giriş yapıldıysa) dokunma
    if (!acc.token || seeded.get(acc.igUserId) !== acc.token) continue;
    const cookies = await igSession(acc.igUserId).cookies.get({ url: IG_BASE() });
    if (!cookies.some((c) => c.name === 'sessionid' && c.value)) continue;
    const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (str !== acc.token) {
      acc.token = str;
      seeded.set(acc.igUserId, str);
      changed = true;
    }
  }
  if (changed) store.save();
}

// ---- Yapay zekâ asistanı için hesap verisi ----
const contextCache = new Map(); // hesap id -> { at, text }
async function accountContext(acc) {
  const hit = contextCache.get(acc.id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  const c = clientFor(acc.token, acc.igUserId);
  const [me, media] = await Promise.all([c.me().catch(() => ({})), c.recentMedia(24).catch(() => [])]);
  const n = (v) => (v == null ? '?' : String(v));
  const lines = [
    `Bugün: ${new Date().toISOString().slice(0, 10)}`,
    `Hesap: @${acc.username}${me.name ? ` (${me.name})` : ''}${me.category ? ` · ${me.category}` : ''}`,
    `Biyografi: ${me.biography || '(alınamadı)'}`,
    `Takipçi: ${n(me.follower_count)} · Takip edilen: ${n(me.following_count)} · Gönderi: ${n(me.media_count)}`,
    '',
    `Son ${media.length} gönderi (yeniden eskiye): tarih | tür | beğeni | yorum | izlenme | açıklama`,
    ...media.map(
      (m) =>
        `- ${(m.timestamp || '').slice(0, 10)} | ${m.is_reel ? 'Reels' : m.media_type === 8 ? 'Albüm' : m.media_type === 2 ? 'Video' : 'Fotoğraf'} | ${n(m.like_count)} | ${n(m.comments_count)} | ${n(m.play_count)} | ${String(m.caption || '').replace(/\s+/g, ' ').slice(0, 160)}`
    ),
    '',
    'Uygulamadaki otomasyonlar:',
    ...store.data.rules
      .filter((r) => r.accountId === acc.id)
      .map((r) => {
        const s = store.data.stats[r.id] || {};
        return `- ${r.name} (${r.type}, kelimeler: ${r.keywords || 'hepsi'}, ${r.active ? 'aktif' : 'kapalı'}) tetiklenme ${s.triggered || 0}, gönderilen ${s.sent || 0}, takip şartına takılan ${s.gated || 0}`;
      }),
    `Toplanan kişi: ${store.data.contacts.filter((x) => x.accountId === acc.id).length}`,
  ];
  const text = lines.join('\n');
  contextCache.set(acc.id, { at: Date.now(), text });
  return text;
}

function contactsCsv() {
  const accName = (id) => (store.getAccount(id) || {}).username || '';
  const cell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // Excel formül enjeksiyonunu önle
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = [['Kullanıcı adı', 'Hesap', 'E-posta', 'Telefon', 'Etiketler', 'Etkileşim', 'İlk görülme', 'Son görülme', 'Son mesaj']];
  for (const c of store.data.contacts) {
    rows.push([c.username || c.userId, accName(c.accountId), c.email, c.phone, (c.tags || []).join(', '), c.interactions, c.firstSeen, c.lastSeen, c.lastMessage]);
  }
  // Excel'in Türkçe karakterleri doğru açması için BOM; Türkçe Excel ';' ayırıcı bekler
  return '\ufeff' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
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

  handle('account:login', async (creds = {}) => {
    const username = String(creds.username || '').trim().replace(/^@/, '');
    const password = String(creds.password || '');
    if (!username) throw new Error('Instagram kullanıcı adınızı yazın.');
    if (username.includes('@')) throw new Error('E-posta değil, Instagram kullanıcı adınızı yazın (örn. dj_engine).');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new Error('Kullanıcı adı sadece harf, rakam, nokta ve alt çizgi içerebilir.');
    if (!password) throw new Error('Şifrenizi yazın.');
    const cookies = await loginWithInstagram({ username, password });
    const igUserId = parseCookies(cookies).ds_user_id;
    if (!igUserId) throw new Error('Instagram girişi tamamlanmadı, lütfen tekrar deneyin.');
    // Giriş tamam. Profil bilgisi (ad, fotoğraf) sadece süs: alınamazsa (örn. Instagram
    // "çok fazla istek" derse) hesap yine de kaydedilir, tekrar giriş gerekmez.
    let me = {};
    try {
      me = await clientFor(cookies, igUserId).me();
    } catch (e) {
      if (e.isAuth) throw e;
    }
    const prev = store.data.accounts.find((a) => a.igUserId === igUserId);
    const now = new Date().toISOString();
    const acc = store.upsertAccount({
      igUserId,
      username: me.username || username,
      name: me.name || (prev && prev.name) || '',
      picture: me.profile_picture_url || (prev && prev.picture) || '',
      accountType: me.account_type || (prev && prev.accountType) || '',
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

  handle('account:remove', async (id) => {
    const acc = store.getAccount(id);
    store.removeAccount(id);
    if (acc) {
      seeded.delete(acc.igUserId);
      await igSession(acc.igUserId).clearStorageData().catch(() => {});
    }
  });

  handle('account:media', async (id) => {
    const acc = store.getAccount(id);
    if (!acc || !acc.token) throw new Error('Hesap bulunamadı.');
    return clientFor(acc.token, acc.igUserId).recentMedia(30);
  });

  handle('rule:save', (rule) => {
    if (!rule.name || !rule.name.trim()) throw new Error('Kurala bir isim verin.');
    if (!store.getAccount(rule.accountId)) throw new Error('Bir hesap seçin.');
    if (!['comment', 'dm', 'story'].includes(rule.type)) throw new Error('Tetikleyici türü geçersiz.');
    rule.replyMode = rule.replyMode === 'ai' ? 'ai' : 'fixed';
    if (rule.replyMode === 'fixed' && !String(rule.dmText || '').trim()) throw new Error('Gönderilecek DM mesajını yazın.');
    if (rule.type === 'comment' && rule.mediaScope === 'since' && Number.isNaN(Date.parse(rule.sinceDate || '')))
      throw new Error('"Şu tarihten sonraki gönderiler" için bir tarih seçin.');
    if (rule.type === 'comment' && rule.mediaScope === 'selected' && !(rule.mediaIds || []).length)
      throw new Error('En az bir gönderi seçin ya da "Tüm son gönderiler" seçeneğini kullanın.');
    if (rule.publicReplyEnabled && !String(rule.publicReplyText || '').trim())
      throw new Error('Yoruma yazılacak cevabı girin ya da bu seçeneği kapatın.');
    return store.saveRule(rule);
  });

  handle('rule:remove', (id) => store.removeRule(id));

  handle('settings:update', (patch) => {
    const allowed = ['pollSeconds', 'recentPosts', 'maxSendsPerHour', 'dryRun', 'running', 'openAtLogin', 'notifications', 'aiModel'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if ('aiModel' in clean && !/^[\w.:/-]{1,80}$/.test(String(clean.aiModel))) throw new Error('Model adı geçersiz.');
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

  // ---- Yapay zekâ (Ollama) ----
  handle('ai:status', () => ai.status());

  let pulling = null;
  handle('ai:pull', async () => {
    if (pulling) return pulling;
    const send = (p) => win && !win.isDestroyed() && win.webContents.send('ai-progress', p);
    pulling = ai
      .pull((pct, status) => send({ pct, status }))
      .then(() => send({ pct: 100, status: 'success', done: true }))
      .finally(() => {
        pulling = null;
      });
    return pulling;
  });

  handle('ai:chat', async ({ accountId, messages } = {}) => {
    const acc = store.getAccount(accountId);
    if (!acc || !acc.token) throw new Error('Önce bir Instagram hesabı bağlayın.');
    const context = await accountContext(acc);
    return ai.chat({ context, messages: messages || [], persona: acc.persona });
  });

  // ---- Yapay zekâyı eğitme: "Beni tanı" ----
  const PERSONA_FIELDS = ['about', 'goals', 'info', 'faq', 'tone', 'never', 'address', 'emoji'];
  const cleanExamples = (list) =>
    (Array.isArray(list) ? list : [])
      .map((e) => ({ in: String((e && e.in) || '').trim().slice(0, 1000), out: String((e && e.out) || '').trim().slice(0, 1000), source: e && e.source === 'dm' ? 'dm' : 'manual' }))
      .filter((e) => e.in && e.out)
      .slice(-40);

  handle('persona:save', ({ accountId, persona } = {}) => {
    const acc = store.getAccount(accountId);
    if (!acc) throw new Error('Hesap bulunamadı.');
    const next = { ...(acc.persona || {}) };
    for (const k of PERSONA_FIELDS) if (persona && k in persona) next[k] = String(persona[k] || '').slice(0, 4000);
    if (persona && 'examples' in persona) next.examples = cleanExamples(persona.examples);
    store.updateAccount(acc.id, { persona: next });
    contextCache.delete(acc.id);
    return next;
  });

  // Hesap sahibinin DM'lerdeki gerçek cevaplarını örnek olarak toplar (uygulamanın otomatik gönderdikleri hariç)
  handle('persona:learn', async ({ accountId } = {}) => {
    const acc = store.getAccount(accountId);
    if (!acc || !acc.token) throw new Error('Hesap bulunamadı.');
    const auto = new Set(store.data.log.filter((l) => l.reply).map((l) => l.reply.trim()));
    const pairs = (await clientFor(acc.token, acc.igUserId).myReplies(30)).filter((p) => !auto.has(String(p.out).trim()));
    const existing = (acc.persona && acc.persona.examples) || [];
    const seen = new Set(existing.map((e) => `${e.in}\u0000${e.out}`));
    const added = pairs.filter((p) => !seen.has(`${p.in}\u0000${p.out}`)).map((p) => ({ ...p, source: 'dm' }));
    store.updateAccount(acc.id, { persona: { ...(acc.persona || {}), examples: cleanExamples([...existing, ...added]) } });
    return { added: added.length, found: pairs.length };
  });

  // Deneme alanı: örnek bir mesaja yapay zekâ ne cevap verirdi?
  handle('ai:try', async ({ accountId, text } = {}) => {
    const acc = store.getAccount(accountId);
    if (!acc) throw new Error('Hesap bulunamadı.');
    if (!String(text || '').trim()) throw new Error('Denemek için bir mesaj yazın.');
    const pilot = store.data.rules.find((r) => r.autopilot && r.accountId === acc.id);
    return ai.reply({
      account: acc.username,
      instructions: pilot ? pilot.aiInstructions : '',
      kind: 'dm',
      username: 'musteri',
      incoming: String(text).slice(0, 1000),
      persona: acc.persona,
    });
  });

  // "Otomatik pilot": hesabın tüm DM'lerine yapay zekâ cevap verir
  handle('ai:autopilot', ({ accountId, enabled, instructions } = {}) => {
    const acc = store.getAccount(accountId);
    if (!acc) throw new Error('Hesap bulunamadı.');
    const existing = store.data.rules.find((r) => r.accountId === acc.id && r.autopilot);
    return store.saveRule({
      ...(existing || {}),
      name: 'Yapay zekâ otomatik cevap',
      accountId: acc.id,
      type: 'dm',
      keywords: '',
      replyMode: 'ai',
      aiInstructions: String(instructions || '').slice(0, 4000),
      dmText: '',
      oncePerUser: false,
      autopilot: true,
      active: !!enabled,
    });
  });

  // ---- Kişiler ----
  handle('contacts:export', async () => {
    const csv = contactsCsv();
    let file = process.env.DMO_EXPORT_PATH;
    if (!file) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Kişileri kaydet',
        defaultPath: path.join(app.getPath('desktop'), `kisiler-${new Date().toISOString().slice(0, 10)}.csv`),
        filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    fs.writeFileSync(file, csv, 'utf8');
    return file;
  });

  handle('open:external', (url) => {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && /(^|\.)(instagram\.com|facebook\.com|meta\.com|ollama\.com)$/.test(u.hostname);
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
  ai = new AI(() => ({ model: store.settings.aiModel || DEFAULT_MODEL }));
  engine = new Engine({ store, ai, clientFactory: (cookies, acc) => clientFor(cookies, acc.igUserId) });
  store.onChange(pushState);
  registerIpc();
  createTray();
  createWindow();
  schedule(3000);
});
