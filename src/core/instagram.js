'use strict';

// Instagram istemcisi — instagram.com'a normal kullanıcı girişiyle açılan oturumu kullanır.
// Meta geliştirici uygulaması veya token gerekmez; uygulama içindeki giriş penceresinden
// alınan oturum çerezleriyle Instagram web sitesinin kullandığı uç noktalara istek atar.
//
// DİKKAT: Bu uç noktalar resmî/belgelenmiş değildir; Instagram değiştirebilir. Otomatik
// mesajlaşma Instagram kullanım koşullarına aykırı sayılabilir ve hesap kısıtlanabilir.
const DEFAULT_BASE = 'https://www.instagram.com';
// Instagram DM kutusu, gönderi listesi gibi servisleri artık www'da sunmuyor (404). Aynı servisler,
// aynı oturum çerezleriyle i.instagram.com'da çalışıyor. Sadece web yorum servisi (/web/...) www'da.
const API_HOST = 'https://i.instagram.com';

// Hata mesajında hangi adımın başarısız olduğunu göstermek için
const STEPS = [
  [/^\/direct_v2\/(inbox|pending_inbox)/, 'DM kutusu okunamadı'],
  [/^\/direct_v2\/threads\/broadcast/, 'DM gönderilemedi'],
  [/^\/direct_v2\/threads\/[^/]+\/approve/, 'Mesaj isteği kabul edilemedi'],
  [/^\/direct_v2\/threads/, 'Sohbet okunamadı'],
  [/^\/feed\/user/, 'Gönderiler okunamadı'],
  [/^\/media\/[^/]+\/comments/, 'Yorumlar okunamadı'],
  [/^\/media/, 'Gönderi okunamadı'],
  [/^\/web\/comments/, 'Yoruma cevap yazılamadı'],
  [/^\/friendships/, 'Takip durumu okunamadı'],
  [/^\/users/, 'Profil okunamadı'],
];
const stepOf = (path) => (STEPS.find(([re]) => re.test(path)) || [null, 'Instagram isteği başarısız'])[1];
const WEB_APP_ID = '936619743392459';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

class InstagramError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.name = 'InstagramError';
    this.status = status;
    this.type = type;
  }

  get isAuth() {
    return this.type === 'auth' || this.status === 401;
  }

  get isRateLimit() {
    return this.type === 'rate' || this.status === 429;
  }
}

// 16+ haneli sayılar JavaScript'te hassasiyet kaybeder (Instagram id'leri böyle); metne çevir.
function parseJson(text) {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

const iso = (seconds) => (seconds ? new Date(Number(seconds) * 1000).toISOString() : null);
const isoMicro = (us) => (us ? new Date(Math.floor(Number(us) / 1000)).toISOString() : null);

function parseCookies(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function normalizeMedia(m) {
  const pk = String(m.pk || String(m.id || '').split('_')[0]);
  const img = (m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0]) || null;
  const firstCarousel = (m.carousel_media && m.carousel_media[0]) || null;
  const carouselImg =
    firstCarousel && firstCarousel.image_versions2 && firstCarousel.image_versions2.candidates && firstCarousel.image_versions2.candidates[0];
  return {
    id: pk,
    caption: (m.caption && m.caption.text) || '',
    permalink: m.code ? `https://www.instagram.com/p/${m.code}/` : null,
    timestamp: iso(m.taken_at),
    media_type: m.media_type,
    thumbnail_url: (img && img.url) || (carouselImg && carouselImg.url) || null,
    comments_count: m.comment_count != null ? Number(m.comment_count) : null,
    like_count: m.like_count != null ? Number(m.like_count) : null,
    play_count: m.play_count != null ? Number(m.play_count) : m.view_count != null ? Number(m.view_count) : null,
    // Reels: product_type "clips" (video gönderiler de media_type 2'dir ama Reels değildir)
    is_reel: m.product_type === 'clips',
  };
}

class InstagramClient {
  // `session`: giriş penceresinden alınan çerezler ("sessionid=...; csrftoken=...; ds_user_id=...").
  // `browserFetch`: Electron'un tarayıcı oturumundan istek atan fetch. Verilirse çerezleri ve
  // tarayıcı kimliğini (User-Agent) oturum yönetir; Instagram istekleri gerçek tarayıcıdan gelmiş görür.
  constructor(session, { baseUrl, apiBaseUrl, fetchImpl, browserFetch } = {}) {
    this.session = session;
    this.cookies = parseCookies(session);
    this.userId = this.cookies.ds_user_id || null;
    this.base = (baseUrl || process.env.IG_WEB_BASE || DEFAULT_BASE).replace(/\/$/, '');
    // Testlerde (sahte sunucu) iki adres aynıdır
    this.apiBase = (apiBaseUrl || (this.base === DEFAULT_BASE ? API_HOST : this.base)).replace(/\/$/, '');
    this.browser = !!browserFetch;
    this.fetch = browserFetch || fetchImpl || globalThis.fetch;
    this.threads = new Map(); // son gelen kutusu okumasındaki konuşmalar
  }

  async request(method, path, { params, form } = {}) {
    const host = path.startsWith('/web/') ? this.base : this.apiBase;
    const u = new URL(`${host}/api/v1${path}`);
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, String(v));
    const headers = {
      'X-IG-App-ID': WEB_APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
      'X-ASBD-ID': '129477',
      Referer: `${this.base}/`,
      Origin: this.base,
      Accept: '*/*',
    };
    if (!this.browser) {
      headers.Cookie = this.session;
      headers['User-Agent'] = USER_AGENT;
    }
    if (this.cookies.csrftoken) headers['X-CSRFToken'] = this.cookies.csrftoken;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await this.fetch(u, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    } catch (e) {
      // Electron'un tarayıcı bağlantısı yönlendirmede (302) cevap yerine "Redirect was cancelled"
      // hatası fırlatır. Instagram API'de yönlendirme = giriş/doğrulama sayfası = oturum kapanmış.
      if (/redirect/i.test(e.message || '')) {
        throw new InstagramError('Instagram oturumu kapanmış. Hesaba yeniden giriş yapın.', { type: 'auth' });
      }
      throw new InstagramError(`Instagram'a bağlanılamadı: ${e.message}`, { type: 'network' });
    }
    // Oturum düşünce Instagram giriş (veya doğrulama) sayfasına yönlendirir
    if (res.status >= 300 && res.status < 400) {
      throw new InstagramError('Instagram oturumu kapanmış. Hesaba yeniden giriş yapın.', { status: res.status, type: 'auth' });
    }
    let json = {};
    try {
      json = parseJson(await res.text());
    } catch (_) {}
    const msg = String(json.message || '');
    if (json.require_login || /login_required|checkpoint_required|challenge_required/.test(msg) || res.status === 401) {
      throw new InstagramError('Instagram oturumu kapanmış veya doğrulama istiyor. Hesaba yeniden giriş yapın.', {
        status: res.status,
        type: 'auth',
      });
    }
    if (res.status === 429 || json.spam || /wait a few minutes|feedback_required|rate.?limit/i.test(msg)) {
      throw new InstagramError(msg || 'Instagram çok fazla istek algıladı, birkaç dakika sonra tekrar denenecek.', {
        status: res.status,
        type: 'rate',
      });
    }
    if (!res.ok || json.status === 'fail') {
      throw new InstagramError(`${stepOf(path)}: ${msg || 'Instagram isteği başarısız'} (HTTP ${res.status})`, { status: res.status });
    }
    return json;
  }

  async me() {
    if (!this.userId) throw new InstagramError('Instagram girişi tamamlanmadı.', { type: 'auth' });
    const r = await this.request('GET', `/users/${this.userId}/info/`);
    const u = r.user || {};
    return {
      user_id: String(u.pk || u.pk_id || this.userId),
      username: u.username,
      name: u.full_name || '',
      profile_picture_url: u.profile_pic_url || '',
      account_type: u.is_business ? 'BUSINESS' : '',
      biography: u.biography || '',
      follower_count: u.follower_count != null ? Number(u.follower_count) : null,
      following_count: u.following_count != null ? Number(u.following_count) : null,
      media_count: u.media_count != null ? Number(u.media_count) : null,
      category: u.category || '',
    };
  }

  // Kişi bu hesabı takip ediyor mu?
  async isFollower(userId) {
    if (!userId || String(userId).startsWith('u:')) return false;
    const r = await this.request('GET', `/friendships/show/${userId}/`);
    return !!r.followed_by;
  }

  async recentMedia(limit = 10) {
    const r = await this.request('GET', `/feed/user/${this.userId}/`, { params: { count: limit } });
    return (r.items || []).slice(0, limit).map(normalizeMedia);
  }

  async media(mediaId) {
    const r = await this.request('GET', `/media/${mediaId}/info/`);
    if (!r.items || !r.items[0]) throw new InstagramError('Gönderi bulunamadı.');
    return normalizeMedia(r.items[0]);
  }

  async comments(mediaId) {
    const r = await this.request('GET', `/media/${mediaId}/comments/`, {
      params: { can_support_threading: 'true', permalink_enabled: 'false' },
    });
    return (r.comments || []).map((c) => ({
      id: String(c.pk),
      text: c.text || '',
      timestamp: iso(c.created_at_utc || c.created_at),
      username: (c.user && c.user.username) || '',
      from: { id: String((c.user && (c.user.pk || c.user.pk_id)) || ''), username: (c.user && c.user.username) || '' },
    }));
  }

  // Yorum yapan kişiye DM gönderir.
  privateReply(_commentId, text, target = {}) {
    return this.sendMessage(target.userId, text);
  }

  replyToComment(commentId, text, target = {}) {
    return this.request('POST', `/web/comments/${target.mediaId}/add/`, {
      form: { comment_text: text, replied_to_comment_id: commentId },
    });
  }

  // Gelen kutusu + mesaj istekleri (takip etmeyenlerin DM'leri "istekler"e düşer)
  async conversations(limit = 20) {
    const params = { persistentBadging: 'true', folder: '', limit, thread_message_limit: 10 };
    const r = await this.request('GET', '/direct_v2/inbox/', { params });
    let pending = [];
    try {
      const p = await this.request('GET', '/direct_v2/pending_inbox/', { params });
      pending = (p.inbox && p.inbox.threads) || [];
    } catch (e) {
      if (e.isAuth || e.isRateLimit || e.type === 'network') throw e;
    }
    this.threads.clear();
    const out = [];
    for (const [list, isPending] of [[(r.inbox && r.inbox.threads) || [], false], [pending, true]]) {
      for (const t of list) {
        const id = String(t.thread_id);
        if (this.threads.has(id)) continue;
        this.threads.set(id, { ...t, pending: isPending });
        out.push({ id, updated_time: isoMicro(t.last_activity_at), pending: isPending });
      }
    }
    return out;
  }

  // Hesap sahibinin DM'lerde verdiği gerçek cevaplar: [{ in: gelen mesaj, out: benim cevabım }]
  async myReplies(max = 30) {
    const r = await this.request('GET', '/direct_v2/inbox/', {
      params: { persistentBadging: 'true', folder: '', limit: 40, thread_message_limit: 20 },
    });
    const pairs = [];
    for (const t of (r.inbox && r.inbox.threads) || []) {
      const items = (t.items || []).slice().reverse(); // Instagram en yeniyi önce verir
      let lastIn = null;
      for (const it of items) {
        if (it.item_type !== 'text' || !String(it.text || '').trim()) continue;
        if (String(it.user_id) === this.userId) {
          if (lastIn) pairs.push({ in: lastIn, out: it.text });
          lastIn = null;
        } else lastIn = it.text;
      }
    }
    return pairs.slice(0, max);
  }

  // Mesaj isteğini kabul eder (cevap verilmeden önce; Instagram uygulamasında cevap yazınca da olur)
  approveThread(threadId) {
    return this.request('POST', `/direct_v2/threads/${threadId}/approve/`, { form: {} });
  }

  async conversationMessages(conversationId, limit = 10) {
    let t = this.threads.get(conversationId);
    if (!t) {
      const r = await this.request('GET', `/direct_v2/threads/${conversationId}/`, { params: { limit } });
      t = r.thread || {};
    }
    const users = new Map((t.users || []).map((u) => [String(u.pk || u.pk_id), u.username]));
    // Instagram en yeniyi önce verir; eskiden yeniye çevir (aynı zaman damgasında doğru sıra korunur)
    return (t.items || []).slice(0, limit).reverse().map((it) => {
      const from = String(it.user_id);
      // Hikâyeye cevap: item_type "reel_share" (type "reply"), metni reel_share.text içinde
      const story = it.item_type === 'reel_share' && it.reel_share && it.reel_share.type !== 'mention';
      return {
        id: String(it.item_id),
        created_time: isoMicro(it.timestamp),
        from: { id: from, username: users.get(from) || '' },
        kind: story ? 'story' : 'dm',
        message: it.item_type === 'text' ? it.text || '' : story ? it.reel_share.text || '' : '',
      };
    });
  }

  sendMessage(recipientId, text) {
    if (!recipientId || String(recipientId).startsWith('u:')) throw new InstagramError('Alıcı bulunamadı.');
    const ctx = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    return this.request('POST', '/direct_v2/threads/broadcast/text/', {
      form: {
        recipient_users: JSON.stringify([[String(recipientId)]]),
        action: 'send_item',
        client_context: ctx,
        offline_threading_id: ctx,
        mutation_token: ctx,
        text,
      },
    });
  }
}

module.exports = { InstagramClient, InstagramError, parseCookies, parseJson, USER_AGENT };
