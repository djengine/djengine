'use strict';

const { InstagramClient, InstagramError } = require('./instagram');
const { matchesKeywords, fillTemplate, pickVariant } = require('./match');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PRIVATE_REPLY_WINDOW = 7 * DAY; // Instagram: yoruma özel DM en fazla 7 gün içinde
const MESSAGING_WINDOW = DAY; // Instagram: kişi son yazdıktan sonra 24 saat içinde cevap
const RATE_LIMIT_BACKOFF = 15 * 60 * 1000;
const GATE_TTL = 7 * DAY; // takip şartı bekleyenler bu süre sonra unutulur

const DEFAULT_FOLLOW_PROMPT =
  "Selam {username}! 🙌 Mesajı gönderebilmem için önce hesabımı takip etmen gerekiyor. Takip ettikten sonra bana buradan \"tamam\" yazman yeterli, hemen gönderiyorum.";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s().-]{8,}\d)/;

class RetryLater extends Error {}

// DM metninden e-posta ve telefon çıkarır (kişi toplama)
function extractLead(text) {
  const s = String(text || '');
  const email = (s.match(EMAIL_RE) || [])[0] || null;
  let phone = null;
  const m = s.replace(EMAIL_RE, ' ').match(PHONE_RE);
  if (m) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) phone = m[1].trim();
  }
  return { email, phone };
}

class Engine {
  // ai: { reply({account, instructions, kind, username, incoming}) } — yapay zekâ cevapları için (isteğe bağlı)
  constructor({ store, clientFactory, now, random, ai } = {}) {
    this.store = store;
    this.clientFactory = clientFactory || ((token) => new InstagramClient(token));
    this.now = now || (() => Date.now());
    this.random = random || Math.random;
    this.ai = ai || null;
    this.busy = false;
    this.lastTickAt = null;
  }

  // Kontroller sıraya alınır: biri sürerken gelen istek, öncekinin bitmesini bekleyip sonra çalışır.
  tick() {
    const p = (this.chain || Promise.resolve()).then(() => this.runOnce());
    this.chain = p.catch(() => {});
    return p;
  }

  async runOnce() {
    this.busy = true;
    try {
      for (const acc of this.store.data.accounts) {
        if (!acc.token || acc.status === 'auth') continue;
        if (acc.backoffUntil && Date.parse(acc.backoffUntil) > this.now()) continue;
        await this.pollAccount(acc);
      }
      this.lastTickAt = new Date(this.now()).toISOString();
    } finally {
      this.busy = false;
      this.store.save();
    }
  }

  rulesFor(acc, ...types) {
    return this.store.data.rules.filter((r) => r.active && r.accountId === acc.id && types.includes(r.type));
  }

  async pollAccount(acc) {
    const client = this.clientFactory(acc.token, acc);
    try {
      const commentRules = this.rulesFor(acc, 'comment');
      const messageRules = this.rulesFor(acc, 'dm', 'story');
      const st = this.store.accountState(acc.id);
      this.expireGates(st);
      const waitingGates = Object.keys(st.gates).length > 0;
      if (commentRules.length) await this.pollComments(acc, client, commentRules);
      if (messageRules.length || waitingGates) await this.pollMessages(acc, client, messageRules);
      if (acc.status !== 'ok' || acc.lastError) {
        acc.status = 'ok';
        acc.lastError = null;
      }
      acc.lastPollAt = new Date(this.now()).toISOString();
    } catch (e) {
      this.handleError(acc, e);
    }
  }

  handleError(acc, e) {
    if (e instanceof RetryLater) return;
    const previous = acc.lastError;
    if (e instanceof InstagramError && e.type === 'network') {
      acc.status = 'offline';
      acc.lastError = 'İnternet bağlantısı yok, bağlantı gelince devam edilecek.';
    } else if (e instanceof InstagramError && e.isAuth) {
      acc.status = 'auth';
      acc.lastError = e.message;
    } else if (e instanceof InstagramError && e.isRateLimit) {
      acc.status = 'limit';
      acc.backoffUntil = new Date(this.now() + RATE_LIMIT_BACKOFF).toISOString();
      acc.lastError = 'Instagram istek limitine ulaşıldı, 15 dakika bekleniyor.';
    } else {
      acc.status = 'error';
      acc.lastError = e.message;
    }
    // Aynı hata her turda tekrar tekrar kaydedilmesin
    if (acc.lastError === previous) return;
    this.store.addLog({ type: 'error', accountId: acc.id, account: acc.username, message: acc.lastError });
  }

  expireGates(st) {
    for (const [k, g] of Object.entries(st.gates)) if (this.now() - Date.parse(g.at) > GATE_TTL) delete st.gates[k];
  }

  // Kural bu gönderide çalışır mı? (tüm son gönderiler / seçili / sadece Reels / tarihten sonra)
  ruleAppliesToMedia(rule, media) {
    switch (rule.mediaScope) {
      case 'selected':
        return (rule.mediaIds || []).includes(media.id);
      case 'reels':
        return !!media.is_reel;
      case 'since': {
        const since = Date.parse(rule.sinceDate || '');
        if (Number.isNaN(since)) return true;
        return Date.parse(media.timestamp || 0) >= since;
      }
      default:
        return true;
    }
  }

  async pollComments(acc, client, rules) {
    const st = this.store.accountState(acc.id);
    const recent = await client.recentMedia(this.store.settings.recentPosts || 10);
    const mediaList = recent.filter((m) => rules.some((r) => this.ruleAppliesToMedia(r, m)));

    // Son gönderilerde olmayan, özellikle seçilmiş eski gönderiler
    const recentIds = new Set(recent.map((m) => m.id));
    const extraIds = new Set();
    for (const r of rules) {
      if (r.mediaScope === 'selected') for (const id of r.mediaIds || []) if (!recentIds.has(id)) extraIds.add(id);
    }
    for (const id of extraIds) {
      try {
        mediaList.push(await client.media(id));
      } catch (e) {
        if (e instanceof InstagramError && (e.isAuth || e.isRateLimit)) throw e;
      }
    }

    const baseline = Date.parse(acc.baselineAt);
    for (const media of mediaList) {
      if (media.comments_count != null && st.commentCounts[media.id] === media.comments_count) continue;
      const comments = await client.comments(media.id);
      comments.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      for (const c of comments) {
        const key = `c:${c.id}`;
        if (this.store.hasSeen(acc.id, key)) continue;
        const ts = Date.parse(c.timestamp);
        const fromId = c.from && c.from.id;
        const username = c.username || (c.from && c.from.username) || '';
        const own = fromId === acc.igUserId || (username && username === acc.username);
        const tooOld = ts < baseline || this.now() - ts > PRIVATE_REPLY_WINDOW;
        if (own || tooOld) {
          this.store.markSeen(acc.id, key);
          continue;
        }
        const rule = rules.find((r) => this.ruleAppliesToMedia(r, media) && matchesKeywords(c.text, r.keywords));
        if (rule) {
          await this.act(acc, client, rule, {
            kind: 'comment',
            commentId: c.id,
            mediaId: media.id,
            userId: fromId || `u:${username}`,
            username,
            text: c.text,
            caption: media.caption,
            permalink: media.permalink,
          });
        }
        this.store.markSeen(acc.id, key);
      }
      st.commentCounts[media.id] = media.comments_count;
    }
  }

  async pollMessages(acc, client, rules) {
    const st = this.store.accountState(acc.id);
    const baseline = Date.parse(acc.baselineAt);
    const convs = await client.conversations(20);
    for (const conv of convs) {
      if (st.convUpdated[conv.id] === conv.updated_time) continue;
      if (conv.updated_time && this.now() - Date.parse(conv.updated_time) > MESSAGING_WINDOW) {
        st.convUpdated[conv.id] = conv.updated_time;
        continue;
      }
      const msgs = await client.conversationMessages(conv.id, 10);
      msgs.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
      const isOwn = (m) => (m.from || {}).id === acc.igUserId || ((m.from || {}).username && m.from.username === acc.username);
      // Sohbetteki son kendi mesajım: ondan önceki gelen mesajlara zaten (bizzat ya da otomatik) cevap verilmiş
      let lastOwn = -1;
      msgs.forEach((m, i) => {
        if (isOwn(m)) lastOwn = i;
      });
      for (const [i, m] of msgs.entries()) {
        const key = `m:${m.id}`;
        if (this.store.hasSeen(acc.id, key)) continue;
        const from = m.from || {};
        const ts = Date.parse(m.created_time);
        const own = isOwn(m);
        if (own || i < lastOwn || ts < baseline || this.now() - ts > MESSAGING_WINDOW || !m.message) {
          this.store.markSeen(acc.id, key);
          continue;
        }
        const kind = m.kind === 'story' ? 'story' : 'dm';
        this.captureLead(acc, from, m.message);
        const unlocked = await this.resolveGates(acc, client, from);
        const rule = unlocked ? null : rules.find((r) => r.type === kind && matchesKeywords(m.message, r.keywords));
        if (rule) {
          await this.act(acc, client, rule, {
            kind,
            userId: from.id,
            username: from.username || '',
            text: m.message,
            threadId: conv.id,
            pending: !!conv.pending,
            history: this.historyOf(acc, msgs, m),
          });
        }
        this.store.markSeen(acc.id, key);
      }
      st.convUpdated[conv.id] = conv.updated_time;
    }
  }

  // Yapay zekâ için sohbetin son mesajları (eskiden yeniye), şu anki mesaj hariç
  historyOf(acc, msgs, current) {
    const out = [];
    for (const m of msgs) {
      if (m.id === current.id) break;
      if (!m.message) continue;
      out.push({ me: (m.from || {}).id === acc.igUserId, text: String(m.message).slice(0, 500) });
    }
    return out.slice(-8);
  }

  // Gelen DM'deki e-posta/telefonu kişiler listesine kaydeder
  captureLead(acc, from, text) {
    const { email, phone } = extractLead(text);
    if (!email && !phone) return;
    this.store.upsertContact(acc.id, from.id, { username: from.username, email, phone, text });
    this.store.addLog({
      type: 'lead',
      accountId: acc.id,
      account: acc.username,
      user: from.username,
      message: `Kişi bilgisi kaydedildi: ${[email, phone].filter(Boolean).join(', ')}`,
    });
  }

  // Takip şartı bekleyen kişi yazınca: takip ettiyse asıl mesajı gönder
  async resolveGates(acc, client, from) {
    const st = this.store.accountState(acc.id);
    const waiting = Object.entries(st.gates).filter(([, g]) => g.userId === String(from.id));
    if (!waiting.length) return false;
    let follows = false;
    try {
      follows = await client.isFollower(from.id);
    } catch (e) {
      if (e instanceof InstagramError && (e.isAuth || e.isRateLimit || e.type === 'network')) throw e;
    }
    if (!follows) {
      this.store.addLog({
        type: 'skip',
        accountId: acc.id,
        account: acc.username,
        user: from.username,
        message: 'Takip şartı: yazdı ama hâlâ takip etmiyor.',
      });
      return false;
    }
    for (const [k, g] of waiting) {
      const rule = this.store.data.rules.find((r) => r.id === g.ruleId && r.active);
      delete st.gates[k];
      if (!rule) continue;
      this.store.bumpStat(rule.id, 'unlocked');
      await this.act(acc, client, rule, { ...g.target, viaGate: true }, { skipGate: true });
    }
    return true;
  }

  checkHourlyLimit(acc) {
    const st = this.store.accountState(acc.id);
    const hourAgo = this.now() - HOUR;
    st.sendTimes = st.sendTimes.filter((t) => t > hourAgo);
    if (st.sendTimes.length >= (this.store.settings.maxSendsPerHour || 40)) {
      acc.lastError = 'Saatlik gönderim sınırına ulaşıldı, sıradaki mesajlar biraz sonra gönderilecek.';
      throw new RetryLater();
    }
  }

  // DM (ve varsa herkese açık yorum cevabı) gönderir. Başarılıysa true.
  async deliver(acc, client, rule, target, dmText, publicText, base) {
    try {
      if (dmText) {
        // Mesaj isteğiyse önce kabul et (yoksa cevap kişiye ulaşmayabilir)
        if (target.pending && target.threadId && !target.approved) {
          try {
            await client.approveThread(target.threadId);
          } catch (e) {
            if (e instanceof InstagramError && (e.isAuth || e.isRateLimit || e.type === 'network')) throw e;
          }
          target.approved = true;
        }
        if (target.kind === 'comment' && !target.viaGate) await client.privateReply(target.commentId, dmText, target);
        else await client.sendMessage(target.userId, dmText);
      }
      if (publicText) await client.replyToComment(target.commentId, publicText, target);
    } catch (e) {
      // Kimlik veya limit hatasında tüm turu durdur; yorum "görülmedi" kalır ve sonra tekrar denenir.
      if (e instanceof InstagramError && (e.isAuth || e.isRateLimit)) throw e;
      if (e instanceof InstagramError && e.type === 'network') throw e;
      this.store.bumpStat(rule.id, 'errors');
      this.store.addLog({ ...base, type: 'error', message: `Gönderilemedi: ${e.message}` });
      return false;
    }
    this.store.accountState(acc.id).sendTimes.push(this.now());
    return true;
  }

  async composeDm(acc, rule, target, vars) {
    if (rule.replyMode !== 'ai') return fillTemplate(pickVariant(rule.dmText, this.random), vars);
    if (!this.ai) {
      acc.lastError = 'Yapay zekâ kullanılamıyor.';
      throw new RetryLater();
    }
    try {
      return await this.ai.reply({
        account: acc.username,
        instructions: rule.aiInstructions,
        kind: target.kind,
        username: target.username,
        incoming: target.text,
        persona: acc.persona,
        history: target.history,
        caption: target.caption,
      });
    } catch (e) {
      // Ollama kapalıysa mesaj kaybolmasın: yorum/DM "görülmedi" kalır, sonra tekrar denenir
      acc.lastError = `Yapay zekâ: ${e.message}`;
      throw new RetryLater();
    }
  }

  async act(acc, client, rule, target, { skipGate = false } = {}) {
    const st = this.store.accountState(acc.id);
    const settings = this.store.settings;
    const sentKey = `${rule.id}:${target.userId}`;
    const base = {
      accountId: acc.id,
      account: acc.username,
      trigger: target.kind,
      rule: rule.name,
      user: target.username,
      incoming: target.text,
      permalink: target.permalink,
    };

    if (!skipGate) {
      this.store.bumpStat(rule.id, 'triggered');
      this.store.upsertContact(acc.id, target.userId, { username: target.username, tag: rule.name, text: target.text });
    }

    if (rule.oncePerUser && st.sentTo.includes(sentKey)) {
      this.store.bumpStat(rule.id, 'skipped');
      this.store.addLog({ ...base, type: 'skip', message: 'Bu kişiye bu kuraldan daha önce mesaj gönderildi.' });
      return;
    }

    const vars = { username: target.username ? `@${target.username}` : '', kullanici: target.username ? `@${target.username}` : '' };
    const publicText =
      target.kind === 'comment' && !target.viaGate && rule.publicReplyEnabled
        ? fillTemplate(pickVariant(rule.publicReplyText, this.random), vars)
        : '';

    // Takip şartı: takip etmeyene önce "takip et" mesajı gider
    if (rule.followGate && !skipGate) {
      let follows = false;
      try {
        follows = await client.isFollower(target.userId);
      } catch (e) {
        if (e instanceof InstagramError && (e.isAuth || e.isRateLimit || e.type === 'network')) throw e;
      }
      if (!follows) {
        if (st.gates[sentKey]) return; // zaten takip etmesi istendi
        const prompt = fillTemplate(pickVariant(rule.followPrompt || DEFAULT_FOLLOW_PROMPT, this.random), vars);
        this.store.bumpStat(rule.id, 'gated');
        if (settings.dryRun) {
          this.store.addLog({ ...base, type: 'dry', reply: prompt, publicReply: publicText || undefined, message: 'Takip etmiyor: önce takip etmesi istenecekti.' });
          return;
        }
        this.checkHourlyLimit(acc);
        if (!(await this.deliver(acc, client, rule, target, prompt, publicText, base))) return;
        st.gates[sentKey] = { ruleId: rule.id, userId: String(target.userId), at: new Date(this.now()).toISOString(), target };
        this.store.addLog({
          ...base,
          type: 'gate',
          reply: prompt,
          publicReply: publicText || undefined,
          message: 'Takip etmiyor; takip etmesi istendi. Takip edip yazınca asıl mesaj gönderilecek.',
        });
        return;
      }
    }

    if (!settings.dryRun) this.checkHourlyLimit(acc);
    const dmText = await this.composeDm(acc, rule, target, vars);

    if (settings.dryRun) {
      this.store.bumpStat(rule.id, 'dry');
      this.store.addLog({ ...base, type: 'dry', reply: dmText, publicReply: publicText || undefined });
      return;
    }

    if (!(await this.deliver(acc, client, rule, target, dmText, publicText, base))) return;
    this.store.bumpStat(rule.id, 'sent');
    if (rule.oncePerUser) {
      st.sentTo.push(sentKey);
      if (st.sentTo.length > 5000) st.sentTo.splice(0, st.sentTo.length - 5000);
    }
    this.store.addLog({ ...base, type: 'sent', reply: dmText, publicReply: publicText || undefined, message: target.viaGate ? 'Takip etti, asıl mesaj gönderildi.' : undefined });
  }
}

module.exports = { Engine, RetryLater, extractLead, DEFAULT_FOLLOW_PROMPT, PRIVATE_REPLY_WINDOW, MESSAGING_WINDOW };
