'use strict';

// Testler için Instagram Graph API'yi taklit eden küçük bir HTTP sunucusu.
const http = require('http');

function createFakeInstagram() {
  const state = {
    accounts: {}, // token -> { user_id, username }
    media: {}, // token -> [ { id, caption, permalink, timestamp, comments: [] } ]
    conversations: {}, // token -> [ { id, updated_time, messages: [] } ]
    sent: [], // gönderilen tüm DM ve yanıtlar
    requests: [],
    failNext: null, // { code, message, status }
  };
  let idCounter = 1000;
  const nextId = () => String(++idCounter);

  const api = {
    state,
    addAccount(token, username, userId = nextId()) {
      state.accounts[token] = { user_id: userId, username, id: `app-${userId}`, account_type: 'MEDIA_CREATOR' };
      state.media[token] = [];
      state.conversations[token] = [];
      return state.accounts[token];
    },
    addMedia(token, caption, timestamp = new Date().toISOString()) {
      const m = { id: nextId(), caption, permalink: `https://instagram.com/p/${idCounter}`, timestamp, media_type: 'IMAGE', comments: [] };
      state.media[token].unshift(m);
      return m;
    },
    addComment(token, mediaId, { username, text, fromId = `u-${username}`, timestamp = new Date().toISOString() }) {
      const m = state.media[token].find((x) => x.id === mediaId);
      const c = { id: nextId(), text, username, from: { id: fromId, username }, timestamp };
      m.comments.unshift(c);
      return c;
    },
    addMessage(token, { username, text, fromId = `u-${username}`, timestamp = new Date().toISOString() }) {
      let conv = state.conversations[token].find((c) => c.with === fromId);
      if (!conv) {
        conv = { id: nextId(), with: fromId, messages: [] };
        state.conversations[token].unshift(conv);
      }
      const msg = { id: nextId(), created_time: timestamp, from: { id: fromId, username }, message: text };
      conv.messages.unshift(msg);
      conv.updated_time = timestamp;
      return msg;
    },
  };

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const token = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('access_token');
      state.requests.push({ method: req.method, path: url.pathname, search: url.search });
      if (state.failNext) {
        const f = state.failNext;
        state.failNext = null;
        return send(res, f.status || 400, { error: { message: f.message || 'hata', code: f.code } });
      }
      const acc = state.accounts[token];
      if (!acc) return send(res, 400, { error: { message: 'Invalid OAuth access token', code: 190 } });
      const p = url.pathname.replace(/^\/v[\d.]+/, '');
      const body = raw ? JSON.parse(raw) : {};
      const medias = state.media[token];
      const convs = state.conversations[token];
      const mediaOut = (m) => ({ ...m, comments: undefined, comments_count: m.comments.length });

      if (p === '/refresh_access_token') return send(res, 200, { access_token: token, token_type: 'bearer', expires_in: 5184000 });
      if (req.method === 'GET' && p === '/me') return send(res, 200, acc);
      if (req.method === 'GET' && p === '/me/media') {
        const limit = Number(url.searchParams.get('limit') || 25);
        return send(res, 200, { data: medias.slice(0, limit).map(mediaOut) });
      }
      if (req.method === 'GET' && p === '/me/conversations') {
        return send(res, 200, { data: convs.map((c) => ({ id: c.id, updated_time: c.updated_time })) });
      }
      if (req.method === 'POST' && p === '/me/messages') {
        const r = body.recipient || {};
        let comment = null;
        if (r.comment_id) {
          for (const m of medias) comment = comment || m.comments.find((c) => c.id === r.comment_id);
          if (!comment) return send(res, 400, { error: { message: 'Comment not found', code: 100 } });
        }
        state.sent.push({ kind: r.comment_id ? 'private_reply' : 'dm', to: r.comment_id ? comment.username : r.id, text: body.message.text, commentId: r.comment_id });
        return send(res, 200, { recipient_id: r.id || 'x', message_id: nextId() });
      }
      let m;
      if ((m = p.match(/^\/(\d+)\/comments$/))) {
        const media = medias.find((x) => x.id === m[1]);
        if (!media) return send(res, 400, { error: { message: 'Not found', code: 100 } });
        return send(res, 200, { data: media.comments });
      }
      if ((m = p.match(/^\/(\d+)\/replies$/)) && req.method === 'POST') {
        state.sent.push({ kind: 'public_reply', commentId: m[1], text: url.searchParams.get('message') });
        return send(res, 200, { id: nextId() });
      }
      if ((m = p.match(/^\/(\d+)$/)) && req.method === 'GET') {
        const media = medias.find((x) => x.id === m[1]);
        if (media) return send(res, 200, mediaOut(media));
        const conv = convs.find((x) => x.id === m[1]);
        if (conv) return send(res, 200, { id: conv.id, messages: { data: conv.messages } });
        return send(res, 400, { error: { message: 'Not found', code: 100 } });
      }
      send(res, 404, { error: { message: `Bilinmeyen uç: ${req.method} ${p}`, code: 1 } });
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
  fake.addAccount('test-token-1', 'dj_engine');
  fake.addAccount('test-token-2', 'gsridercyprus');
  fake.listen().then((url) => console.log(`Sahte Instagram: ${url}`));
}
