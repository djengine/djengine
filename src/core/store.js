'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SEEN = 5000;
const MAX_LOG = 1000;
const MAX_CONTACTS = 20000;

function defaultData() {
  return {
    version: 1,
    settings: {
      pollSeconds: 60,
      recentPosts: 10,
      maxSendsPerHour: 40,
      dryRun: true,
      running: true,
      openAtLogin: false,
      aiModel: '',
    },
    accounts: [],
    rules: [],
    log: [],
    contacts: [], // etkileşime giren kişiler: e-posta/telefon, etiketler
    stats: {}, // otomasyon (kural) başına sayaçlar
    state: {}, // hesap bazında: görülen yorum/mesaj id'leri, yorum sayıları, gönderim geçmişi
  };
}

// Veriler tek bir JSON dosyasında tutulur. Token'lar `crypto` fonksiyonlarıyla
// (Mac'te Anahtar Zinciri destekli safeStorage) şifrelenerek yazılır.
class Store {
  constructor(file, { encrypt, decrypt } = {}) {
    this.file = file;
    this.encrypt = encrypt || ((s) => s);
    this.decrypt = decrypt || ((s) => s);
    this.data = defaultData();
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = defaultData();
      this.data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
      for (const acc of this.data.accounts) {
        if (acc.tokenEnc) {
          try {
            acc.token = this.decrypt(acc.tokenEnc);
          } catch (e) {
            acc.token = null;
            acc.status = 'error';
            acc.lastError = 'Oturum bilgisi çözülemedi, lütfen hesaba yeniden giriş yapın.';
          }
          delete acc.tokenEnc;
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Bozuk dosyayı kenara al, sıfırdan başla
        try {
          fs.renameSync(this.file, `${this.file}.bozuk-${Date.now()}`);
        } catch (_) {}
      }
      this.data = defaultData();
    }
  }

  save() {
    const out = {
      ...this.data,
      accounts: this.data.accounts.map(({ token, ...rest }) => ({
        ...rest,
        tokenEnc: token ? this.encrypt(token) : null,
      })),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  // ---- Hesaplar ----
  getAccount(id) {
    return this.data.accounts.find((a) => a.id === id);
  }

  upsertAccount(acc) {
    const existing = this.data.accounts.find((a) => a.igUserId === acc.igUserId);
    if (existing) {
      Object.assign(existing, acc, { id: existing.id, baselineAt: existing.baselineAt });
      this.save();
      return existing;
    }
    const created = { id: crypto.randomUUID(), baselineAt: new Date().toISOString(), status: 'ok', ...acc };
    this.data.accounts.push(created);
    this.save();
    return created;
  }

  updateAccount(id, patch) {
    const acc = this.getAccount(id);
    if (!acc) return null;
    Object.assign(acc, patch);
    this.save();
    return acc;
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this.data.rules = this.data.rules.filter((r) => r.accountId !== id);
    this.data.contacts = this.data.contacts.filter((c) => c.accountId !== id);
    delete this.data.state[id];
    this.save();
  }

  // ---- Kurallar ----
  saveRule(rule) {
    const now = new Date().toISOString();
    if (rule.id) {
      const existing = this.data.rules.find((r) => r.id === rule.id);
      if (existing) {
        Object.assign(existing, rule, { updatedAt: now });
        this.save();
        return existing;
      }
    }
    const created = {
      active: true,
      oncePerUser: true,
      ...rule,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.data.rules.push(created);
    this.save();
    return created;
  }

  removeRule(id) {
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    delete this.data.stats[id];
    this.save();
  }

  // ---- Durum ----
  accountState(accountId) {
    if (!this.data.state[accountId]) {
      this.data.state[accountId] = { seen: [], commentCounts: {}, convUpdated: {}, sentTo: [], sendTimes: [] };
    }
    const st = this.data.state[accountId];
    if (!st.gates) st.gates = {}; // takip şartı bekleyenler: "kuralId:kullanıcıId" -> hedef
    return st;
  }

  // ---- Kişiler ----
  upsertContact(accountId, userId, { username, tag, email, phone, text } = {}) {
    if (!userId) return null;
    const now = new Date().toISOString();
    let c = this.data.contacts.find((x) => x.accountId === accountId && x.userId === String(userId));
    if (!c) {
      c = { id: crypto.randomUUID(), accountId, userId: String(userId), username: '', tags: [], firstSeen: now, interactions: 0 };
      this.data.contacts.unshift(c);
      if (this.data.contacts.length > MAX_CONTACTS) this.data.contacts.length = MAX_CONTACTS;
    }
    if (username) c.username = username;
    if (tag && !c.tags.includes(tag)) c.tags.push(tag);
    if (email) c.email = email;
    if (phone) c.phone = phone;
    if (text) c.lastMessage = String(text).slice(0, 300);
    c.lastSeen = now;
    c.interactions = (c.interactions || 0) + 1;
    return c;
  }

  // ---- İstatistik ----
  bumpStat(ruleId, key, n = 1) {
    if (!ruleId) return;
    const s = (this.data.stats[ruleId] = this.data.stats[ruleId] || {});
    s[key] = (s[key] || 0) + n;
  }

  hasSeen(accountId, key) {
    return this.accountState(accountId).seen.includes(key);
  }

  markSeen(accountId, key) {
    const st = this.accountState(accountId);
    st.seen.push(key);
    if (st.seen.length > MAX_SEEN) st.seen.splice(0, st.seen.length - MAX_SEEN);
  }

  addLog(entry) {
    this.data.log.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    if (this.data.log.length > MAX_LOG) this.data.log.length = MAX_LOG;
  }

  clearLog() {
    this.data.log = [];
    this.save();
  }
}

module.exports = { Store, defaultData };
