'use strict';

// Instagram API (Instagram Girişi ile) istemcisi.
// Belgeler: https://developers.facebook.com/docs/instagram-platform
const DEFAULT_BASE = 'https://graph.instagram.com';
const API_VERSION = 'v23.0';

class InstagramError extends Error {
  constructor(message, { code, subcode, status, type } = {}) {
    super(message);
    this.name = 'InstagramError';
    this.code = code;
    this.subcode = subcode;
    this.status = status;
    this.type = type;
  }

  get isAuth() {
    return this.code === 190 || this.status === 401;
  }

  get isRateLimit() {
    return [4, 17, 32, 613].includes(this.code) || this.status === 429;
  }
}

class InstagramClient {
  constructor(token, { baseUrl, fetchImpl } = {}) {
    this.token = token;
    this.base = (baseUrl || process.env.IG_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
  }

  url(path, params = {}) {
    const isAbsolute = /^https?:/.test(path);
    const u = new URL(isAbsolute ? path : `${this.base}/${API_VERSION}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    return u;
  }

  async request(method, path, { params, body } = {}) {
    const u = this.url(path, params);
    const headers = { Authorization: `Bearer ${this.token}` };
    let payload;
    if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.fetch(u, { method, headers, body: payload, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new InstagramError(`Instagram'a bağlanılamadı: ${e.message}`, { type: 'network' });
    }
    let json = {};
    try {
      json = await res.json();
    } catch (_) {}
    if (!res.ok || json.error) {
      const err = json.error || {};
      throw new InstagramError(err.error_user_msg || err.message || `HTTP ${res.status}`, {
        code: err.code,
        subcode: err.error_subcode,
        status: res.status,
        type: err.type,
      });
    }
    return json;
  }

  me() {
    return this.request('GET', '/me', {
      params: { fields: 'user_id,username,name,profile_picture_url,account_type' },
    });
  }

  async recentMedia(limit = 10) {
    const r = await this.request('GET', '/me/media', {
      params: {
        fields: 'id,caption,permalink,timestamp,media_type,media_url,thumbnail_url,comments_count',
        limit,
      },
    });
    return r.data || [];
  }

  media(mediaId) {
    return this.request('GET', `/${mediaId}`, {
      params: { fields: 'id,caption,permalink,timestamp,media_type,media_url,thumbnail_url,comments_count' },
    });
  }

  async comments(mediaId, limit = 50) {
    const r = await this.request('GET', `/${mediaId}/comments`, {
      params: { fields: 'id,text,timestamp,username,from', limit },
    });
    return r.data || [];
  }

  // Yoruma özel DM ("private reply"). Yorum başına bir kez, 7 gün içinde gönderilebilir.
  privateReply(commentId, text) {
    return this.request('POST', '/me/messages', {
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
  }

  replyToComment(commentId, text) {
    return this.request('POST', `/${commentId}/replies`, { params: { message: text } });
  }

  async conversations(limit = 20) {
    const r = await this.request('GET', '/me/conversations', {
      params: { platform: 'instagram', fields: 'id,updated_time', limit },
    });
    return r.data || [];
  }

  async conversationMessages(conversationId, limit = 10) {
    const r = await this.request('GET', `/${conversationId}`, {
      params: { fields: `messages.limit(${limit}){id,created_time,from,to,message}` },
    });
    return (r.messages && r.messages.data) || [];
  }

  sendMessage(recipientId, text) {
    return this.request('POST', '/me/messages', {
      body: { recipient: { id: recipientId }, message: { text } },
    });
  }

  // Uzun süreli token'ı 60 gün daha uzatır (token en az 24 saatlik olmalı).
  refreshToken() {
    return this.request('GET', `${this.base}/refresh_access_token`, {
      params: { grant_type: 'ig_refresh_token', access_token: this.token },
    });
  }
}

module.exports = { InstagramClient, InstagramError, API_VERSION };
