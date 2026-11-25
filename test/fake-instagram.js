'use strict';

// Testler için instagram.com'u taklit eden küçük bir HTTP sunucusu:
// giriş sayfası (çerez ile oturum açar) + uygulamanın kullandığı /api/v1 uç noktaları.
const http = require('http');

function createFakeInstagram() {
  const state = {
    accounts: {}, // username -> { pk, username, password, sessionid }
    media: {}, // username -> [ { pk, code, caption, taken_at, comments: [] } ]
    threads: {}, // username -> [ { thread_id, with, users, items: [], last_activity_at } ]
    sent: [], // gönderilen tüm DM ve yanıtlar
    requests: [],
    failNext: null, // { status, body }
    rateLimitProfile: false, // profil isteğine 429 (gerçek Instagram'da görülen durum)
    followers: {}, // username -> Set(takipçi kullanıcı id)
    rurSeen: 0, // sunucunun verdiği rur çerezini geri gönderen istek sayısı (tarayıcı çerez kavanozu kanıtı)
    logins: 0,
  };
  // Gerçek Instagram id'leri 2^53'ten büyüktür; istemcinin hassasiyet kaybetmediğini test etmek için
  let big = 3400000000000000000n;
  const bigId = () => String(++big);
  let small = 1000;
  const nextId = () => String(++small);

  const api = {
    state,
    addAccount(username, password = 'sifre123', pk = nextId()) {
      const acc = { pk, username, password, sessionid: `sess-${username}-${pk}` };
      state.accounts[username] = acc;
      state.media[username] = [];
      state.threads[username] = [];
      state.followers[username] = new Set();
      return { ...acc, user_id: pk, session: `sessionid=${acc.sessionid}; ds_user_id=${pk}; csrftoken=csrf-${pk}` };
    },
    expireSession(username) {
      state.accounts[username].sessionid = `expired-${Date.now()}`;
    },
    // Hesap sahibinin Instagram'dan bizzat yazdığı cevap (uygulama dışında)
    ownReply(username, toId, text) {
      const t = state.threads[username].find((x) => x.with === toId);
      const ts = String(Date.now() * 1000);
      t.items.unshift({ item_id: bigId(), user_id: state.accounts[username].pk, timestamp: ts, item_type: 'text', text });
      t.last_activity_at = ts;
    },
    follow(username, followerId) {
      state.followers[username].add(followerId);
    },
    addMedia(username, caption, takenAt = Math.floor(Date.now() / 1000), { reel = false, likes = 0 } = {}) {
      const pk = bigId();
      const m = { pk, code: `C${pk.slice(-6)}`, caption, taken_at: takenAt, comments: [], reel, likes };
      state.media[username].unshift(m);
      return { id: pk, ...m };
    },
    addComment(username, mediaId, { username: from, text, fromId = `u-${from}`, createdAt = Math.floor(Date.now() / 1000) }) {
      const m = state.media[username].find((x) => x.pk === mediaId);
      const c = { pk: bigId(), text, created_at: createdAt, user: { pk: fromId, username: from } };
      m.comments.unshift(c);
      return { id: c.pk, ...c };
    },
    addMessage(username, { username: from, text, fromId = `u-${from}`, at = Date.now(), story = false, pending = false }) {
      let t = state.threads[username].find((x) => x.with === fromId);
      if (!t) {
        t = { thread_id: bigId(), with: fromId, pending, users: [{ pk: fromId, username: from }], items: [] };
        state.threads[username].unshift(t);
      }
      const ts = String(at * 1000); // mikrosaniye
      t.items.unshift(
        story
          ? { item_id: bigId(), user_id: fromId, timestamp: ts, item_type: 'reel_share', reel_share: { type: 'reply', text, media: {} } }
          : { item_id: bigId(), user_id: fromId, timestamp: ts, item_type: 'text', text }
      );
      t.last_activity_at = ts;
      return t;
    },
  };

  // Büyük sayıları JSON'a tırnaksız (gerçek Instagram gibi) yazar
  let rur = 0;
  function send(res, status, body, headers = {}) {
    const json = JSON.stringify(body).replace(/"(\d{16,})"/g, '$1');
    res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': `rur=R${++rur}; Path=/`, ...headers });
    res.end(json);
  }
  function html(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Instagram</title></head><body>${body}</body></html>`);
  }
  const loginForm = (err = '') => `
    <h1>Instagram</h1>${err ? `<p id="err">${err}</p>` : ''}
    <form method="post" action="/accounts/login/">
      <input name="username" placeholder="Kullanıcı adı">
      <input name="password" type="password" placeholder="Şifre">
      <button type="submit">Giriş yap</button>
    </form>`;

  const cookiesOf = (req) => {
    const out = {};
    for (const p of String(req.headers.cookie || '').split(';')) {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const form = Object.fromEntries(new URLSearchParams(raw));

      // ---- Giriş sayfası ----
      if (p === '/accounts/login/' && req.method === 'GET') return html(res, 200, loginForm());
      if (p === '/accounts/login/' && req.method === 'POST') {
        const acc = state.accounts[form.username];
        if (!acc || acc.password !== form.password) return html(res, 200, loginForm('Şifre yanlış.'));
        acc.sessionid = `sess-${acc.username}-${++state.logins}`;
        return html(res, 302, '', {
          Location: '/',
          'Set-Cookie': [
            `sessionid=${acc.sessionid}; Path=/; HttpOnly`,
            `ds_user_id=${acc.pk}; Path=/`,
            `csrftoken=csrf-${acc.pk}; Path=/`,
          ],
        });
      }
      if (p === '/' && req.method === 'GET') return html(res, 200, '<h1>Ana sayfa</h1>');

      // ---- API ----
      if (!p.startsWith('/api/v1/')) return html(res, 404, 'Yok');
      state.requests.push({ method: req.method, path: p, search: url.search });
      if (state.failNext) {
        const f = state.failNext;
        state.failNext = null;
        return send(res, f.status || 400, f.body || { message: 'hata', status: 'fail' });
      }
      const c = cookiesOf(req);
      const acc = Object.values(state.accounts).find((a) => a.sessionid === c.sessionid && a.pk === c.ds_user_id);
      if (req.headers['x-ig-app-id'] !== '936619743392459') return send(res, 400, { message: 'useragent mismatch', status: 'fail' });
      // Gerçek Instagram oturumsuz isteği giriş sayfasına yönlendirir (302)
      if (!acc) return html(res, 302, '', { Location: `/accounts/login/?next=${encodeURIComponent(p)}` });
      if (req.method === 'POST' && req.headers['x-csrftoken'] !== c.csrftoken) return send(res, 403, { message: 'CSRF token missing', status: 'fail' });

      const medias = state.media[acc.username];
      const threads = state.threads[acc.username];
      const mediaOut = (m) => ({
        pk: m.pk,
        id: `${m.pk}_${acc.pk}`,
        code: m.code,
        caption: { text: m.caption },
        taken_at: m.taken_at,
        media_type: m.reel ? 2 : 1,
        product_type: m.reel ? 'clips' : 'feed',
        like_count: m.likes,
        play_count: m.reel ? m.likes * 10 : undefined,
        comment_count: m.comments.length,
        image_versions2: { candidates: [] },
      });
      let m;

      if (c.rur) state.rurSeen++;
      if ((m = p.match(/^\/api\/v1\/users\/([^/]+)\/info\/$/))) {
        if (state.rateLimitProfile) return send(res, 429, {});
        const u = Object.values(state.accounts).find((a) => a.pk === m[1]);
        if (!u) return send(res, 404, { message: 'User not found', status: 'fail' });
        return send(res, 200, {
          user: {
            pk: u.pk,
            username: u.username,
            full_name: u.username,
            profile_pic_url: '',
            biography: 'DJ / prodüktör',
            follower_count: 1200 + state.followers[u.username].size,
            following_count: 300,
            media_count: state.media[u.username].length,
          },
          status: 'ok',
        });
      }
      if ((m = p.match(/^\/api\/v1\/friendships\/show\/([^/]+)\/$/))) {
        return send(res, 200, { followed_by: state.followers[acc.username].has(m[1]), following: false, status: 'ok' });
      }
      if ((m = p.match(/^\/api\/v1\/feed\/user\/([^/]+)\/$/))) {
        const count = Number(url.searchParams.get('count') || 12);
        return send(res, 200, { items: medias.slice(0, count).map(mediaOut), status: 'ok' });
      }
      if ((m = p.match(/^\/api\/v1\/media\/(\d+)\/info\/$/))) {
        const media = medias.find((x) => x.pk === m[1]);
        if (!media) return send(res, 400, { message: 'Media not found', status: 'fail' });
        return send(res, 200, { items: [mediaOut(media)], status: 'ok' });
      }
      if ((m = p.match(/^\/api\/v1\/media\/(\d+)\/comments\/$/))) {
        const media = medias.find((x) => x.pk === m[1]);
        if (!media) return send(res, 400, { message: 'Media not found', status: 'fail' });
        return send(res, 200, { comments: media.comments, status: 'ok' });
      }
      if ((m = p.match(/^\/api\/v1\/web\/comments\/(\d+)\/add\/$/)) && req.method === 'POST') {
        const media = medias.find((x) => x.pk === m[1]);
        if (!media) return send(res, 400, { message: 'Media not found', status: 'fail' });
        state.sent.push({ kind: 'public_reply', mediaId: m[1], commentId: form.replied_to_comment_id, text: form.comment_text });
        return send(res, 200, { id: bigId(), status: 'ok' });
      }
      if (p === '/api/v1/direct_v2/inbox/' || p === '/api/v1/direct_v2/pending_inbox/') {
        const wantPending = p.includes('pending');
        return send(res, 200, {
          inbox: { threads: threads.filter((t) => !!t.pending === wantPending).map(({ with: _w, pending: _p, ...t }) => t) },
          status: 'ok',
        });
      }
      if ((m = p.match(/^\/api\/v1\/direct_v2\/threads\/(\d+)\/approve\/$/)) && req.method === 'POST') {
        const t = threads.find((x) => x.thread_id === m[1]);
        if (!t) return send(res, 404, { message: 'thread not found', status: 'fail' });
        t.pending = false;
        state.approved = (state.approved || 0) + 1;
        return send(res, 200, { status: 'ok' });
      }
      if (p === '/api/v1/direct_v2/threads/broadcast/text/' && req.method === 'POST') {
        let to;
        try {
          to = JSON.parse(form.recipient_users)[0][0];
        } catch (_) {
          return send(res, 400, { message: 'bad recipient', status: 'fail' });
        }
        if (!form.text) return send(res, 400, { message: 'empty', status: 'fail' });
        state.sent.push({ kind: 'dm', to, text: form.text });
        // Gönderen hesabın kendi mesajı da sohbete eklenir (gerçek Instagram gibi)
        const t = threads.find((x) => x.with === to);
        if (t) {
          const ts = String(Date.now() * 1000);
          t.items.unshift({ item_id: bigId(), user_id: acc.pk, timestamp: ts, item_type: 'text', text: form.text });
          t.last_activity_at = ts;
        }
        return send(res, 200, { status: 'ok', payload: { item_id: bigId() } });
      }
      send(res, 404, { message: `Bilinmeyen uç: ${req.method} ${p}`, status: 'fail' });
    });
  });

  api.listen = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        api.url = `http://127.0.0.1:${server.address().port}`;
        resolve(api.url);
      });
    });
  api.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return api;
}

module.exports = { createFakeInstagram };

// Doğrudan çalıştırılırsa: elle deneme için sahte sunucuyu başlatır.
if (require.main === module) {
  const fake = createFakeInstagram();
  fake.addAccount('dj_engine');
  fake.addAccount('gsridercyprus');
  fake.listen().then((url) => console.log(`Sahte Instagram: ${url} (şifre: sifre123)`));
}
