'use strict';

const { InstagramClient, InstagramError } = require('./instagram');
const { matchesKeywords, fillTemplate, pickVariant } = require('./match');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PRIVATE_REPLY_WINDOW = 7 * DAY; // Instagram: yoruma özel DM en fazla 7 gün içinde
const MESSAGING_WINDOW = DAY; // Instagram: kişi son yazdıktan sonra 24 saat içinde cevap
const RATE_LIMIT_BACKOFF = 15 * 60 * 1000;

class RetryLater extends Error {}

class Engine {
  constructor({ store, clientFactory, now, random } = {}) {
    this.store = store;
    this.clientFactory = clientFactory || ((token) => new InstagramClient(token));
    this.now = now || (() => Date.now());
    this.random = random || Math.random;
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

  rulesFor(acc, type) {
    return this.store.data.rules.filter((r) => r.active && r.accountId === acc.id && r.type === type);
  }

  async pollAccount(acc) {
    const client = this.clientFactory(acc.token);
    try {
      const commentRules = this.rulesFor(acc, 'comment');
      const dmRules = this.rulesFor(acc, 'dm');
      if (commentRules.length) await this.pollComments(acc, client, commentRules);
      if (dmRules.length) await this.pollMessages(acc, client, dmRules);
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

  ruleAppliesToMedia(rule, mediaId) {
    if (rule.mediaScope !== 'selected') return true;
    return (rule.mediaIds || []).includes(mediaId);
  }

  async pollComments(acc, client, rules) {
    const st = this.store.accountState(acc.id);
    const recent = await client.recentMedia(this.store.settings.recentPosts || 10);
    const mediaList = recent.filter((m) => rules.some((r) => this.ruleAppliesToMedia(r, m.id)));

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
        const rule = rules.find((r) => this.ruleAppliesToMedia(r, media.id) && matchesKeywords(c.text, r.keywords));
        if (rule) {
          await this.act(acc, client, rule, {
            kind: 'comment',
            commentId: c.id,
            mediaId: media.id,
            userId: fromId || `u:${username}`,
            username,
            text: c.text,
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
      for (const m of msgs) {
        const key = `m:${m.id}`;
        if (this.store.hasSeen(acc.id, key)) continue;
        const from = m.from || {};
        const ts = Date.parse(m.created_time);
        const own = from.id === acc.igUserId || (from.username && from.username === acc.username);
        if (own || ts < baseline || this.now() - ts > MESSAGING_WINDOW || !m.message) {
          this.store.markSeen(acc.id, key);
          continue;
        }
        const rule = rules.find((r) => matchesKeywords(m.message, r.keywords));
        if (rule) {
          await this.act(acc, client, rule, {
            kind: 'dm',
            userId: from.id,
            username: from.username || '',
            text: m.message,
          });
        }
        this.store.markSeen(acc.id, key);
      }
      st.convUpdated[conv.id] = conv.updated_time;
    }
  }

  async act(acc, client, rule, target) {
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

    if (rule.oncePerUser && st.sentTo.includes(sentKey)) {
      this.store.addLog({ ...base, type: 'skip', message: 'Bu kişiye bu kuraldan daha önce mesaj gönderildi.' });
      return;
    }

    const vars = { username: target.username ? `@${target.username}` : '', kullanici: target.username ? `@${target.username}` : '' };
    const dmText = fillTemplate(pickVariant(rule.dmText, this.random), vars);
    const publicText =
      target.kind === 'comment' && rule.publicReplyEnabled
        ? fillTemplate(pickVariant(rule.publicReplyText, this.random), vars)
        : '';

    if (settings.dryRun) {
      this.store.addLog({ ...base, type: 'dry', reply: dmText, publicReply: publicText || undefined });
      return;
    }

    const hourAgo = this.now() - HOUR;
    st.sendTimes = st.sendTimes.filter((t) => t > hourAgo);
    if (st.sendTimes.length >= (settings.maxSendsPerHour || 40)) {
      acc.lastError = 'Saatlik gönderim sınırına ulaşıldı, sıradaki mesajlar biraz sonra gönderilecek.';
      throw new RetryLater();
    }

    try {
      if (dmText) {
        if (target.kind === 'comment') await client.privateReply(target.commentId, dmText, target);
        else await client.sendMessage(target.userId, dmText);
      }
      if (publicText) await client.replyToComment(target.commentId, publicText, target);
    } catch (e) {
      // Kimlik veya limit hatasında tüm turu durdur; yorum "görülmedi" kalır ve sonra tekrar denenir.
      if (e instanceof InstagramError && (e.isAuth || e.isRateLimit)) throw e;
      if (e instanceof InstagramError && e.type === 'network') throw e;
      this.store.addLog({ ...base, type: 'error', message: `Gönderilemedi: ${e.message}` });
      return;
    }
    st.sendTimes.push(this.now());
    if (rule.oncePerUser) {
      st.sentTo.push(sentKey);
      if (st.sentTo.length > 5000) st.sentTo.splice(0, st.sentTo.length - 5000);
    }
    this.store.addLog({ ...base, type: 'sent', reply: dmText, publicReply: publicText || undefined });
  }
}

module.exports = { Engine, RetryLater, PRIVATE_REPLY_WINDOW, MESSAGING_WINDOW };
