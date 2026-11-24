'use strict';

/* global api */
let S = null; // uygulama durumu
let view = 'overview';
let logFilter = 'all';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 2800);
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return 'az önce';
  if (d < 3600) return `${Math.floor(d / 60)} dk önce`;
  if (d < 86400) return `${Math.floor(d / 3600)} sa önce`;
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}
const fmtTime = (iso) => new Date(iso).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const accName = (id) => {
  const a = S.accounts.find((x) => x.id === id);
  return a ? `@${a.username}` : '(silinmiş hesap)';
};

const STATUS = {
  ok: ['ok', 'Çalışıyor'],
  auth: ['err', 'Yeniden giriş gerekli'],
  limit: ['warn', 'Limit — bekliyor'],
  offline: ['warn', 'İnternet yok'],
  error: ['err', 'Hata'],
};

// ---------------- Görünümler ----------------
function renderOverview() {
  const today = new Date().toDateString();
  const isToday = (l) => new Date(l.at).toDateString() === today;
  const sent = S.log.filter((l) => l.type === 'sent' && isToday(l)).length;
  const dry = S.log.filter((l) => l.type === 'dry' && isToday(l)).length;
  const active = S.rules.filter((r) => r.active).length;
  const s = S.settings;
  const nextIn = S.engine.nextTickAt ? Math.max(0, Math.round((S.engine.nextTickAt - Date.now()) / 1000)) : null;

  $('#view-overview').innerHTML = `
    <div class="row" style="margin-bottom:4px"><h1>Genel Bakış</h1></div>
    <p class="lead">Instagram yorum ve DM otomasyonlarınız bu Mac açıkken arka planda çalışır.</p>

    <div class="card" style="margin-bottom:16px">
      <div class="row">
        <label class="switch"><input type="checkbox" data-testid="running" id="running" ${s.running ? 'checked' : ''}><span></span></label>
        <div>
          <div style="font-weight:600">${s.running ? (s.dryRun ? 'Test modunda çalışıyor' : 'Otomasyon çalışıyor') : 'Otomasyon duraklatıldı'}</div>
          <div class="muted small">Son kontrol: ${timeAgo(S.engine.lastTickAt)}${nextIn != null ? ` · sonraki kontrol ${nextIn} sn içinde` : ''}</div>
        </div>
        <div class="spacer"></div>
        <button class="btn" id="check-now" data-testid="check-now" ${s.running ? '' : 'disabled'}>Şimdi kontrol et</button>
      </div>
    </div>

    <div class="cards">
      <div class="card stat"><div class="num" data-testid="stat-sent">${sent}</div><div class="lbl">Bugün gönderilen DM</div></div>
      <div class="card stat"><div class="num">${dry}</div><div class="lbl">Bugünkü test kayıtları</div></div>
      <div class="card stat"><div class="num">${active}</div><div class="lbl">Aktif otomasyon</div></div>
      <div class="card stat"><div class="num">${S.accounts.length}</div><div class="lbl">Bağlı hesap</div></div>
    </div>

    ${
      S.accounts.length === 0
        ? `<div class="card empty"><div style="font-weight:600;color:var(--text)">Henüz hesap bağlanmadı</div>
            <div>Başlamak için Instagram hesabınızı bağlayın.</div>
            <button class="btn primary" data-go="accounts">Hesap bağla</button></div>`
        : `<h2>Hesaplar</h2><div class="stack" style="margin-bottom:24px">${S.accounts.map((a) => accountCard(a)).join('')}</div>`
    }

    <div class="row"><h2>Son hareketler</h2><div class="spacer"></div><a class="link small" data-go="activity">Tümü →</a></div>
    <div class="card">${logList(S.log.slice(0, 6)) || '<div class="empty">Henüz hareket yok.</div>'}</div>
  `;
  $('#running').onchange = (e) => run(() => api.updateSettings({ running: e.target.checked }));
  $('#check-now').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Kontrol ediliyor…';
    await run(() => api.checkNow(), 'Kontrol tamamlandı').catch(() => {});
  };
}

function accountCard(a, withActions = false) {
  const [cls, label] = STATUS[a.status] || STATUS.ok;
  const initial = esc((a.username || '?')[0].toUpperCase());
  const ruleCount = S.rules.filter((r) => r.accountId === a.id).length;
  return `
    <div class="card account" data-testid="account-${esc(a.username)}">
      <div class="avatar">${a.picture ? `<img src="${esc(a.picture)}" alt="">` : initial}</div>
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:8px"><strong>@${esc(a.username)}</strong><span class="pill ${cls}">${label}</span></div>
        <div class="muted small">${ruleCount} otomasyon · son kontrol ${timeAgo(a.lastPollAt)}</div>
        ${a.lastError ? `<div class="small" style="color:var(--err);margin-top:4px">${esc(a.lastError)}</div>` : ''}
      </div>
      ${a.status === 'auth' ? `<button class="btn small primary" data-relogin="${esc(a.username)}" data-testid="relogin-${esc(a.username)}">Yeniden giriş yap</button>` : ''}
      ${withActions ? `<button class="btn small danger" data-remove-account="${esc(a.id)}">Kaldır</button>` : ''}
    </div>`;
}

const LOG_META = {
  sent: ['ok', 'Gönderildi'],
  dry: ['warn', 'Test (gönderilmedi)'],
  skip: ['', 'Atlandı'],
  error: ['err', 'Hata'],
  info: ['accent', 'Bilgi'],
};

function logList(items) {
  return items
    .map((l) => {
      const [cls, label] = LOG_META[l.type] || ['', l.type];
      const trig = l.trigger === 'comment' ? 'yorum' : l.trigger === 'dm' ? 'DM' : '';
      return `
      <div class="log-item" data-testid="log-${esc(l.type)}">
        <div class="log-time">${fmtTime(l.at)}</div>
        <div class="log-main">
          <div class="row" style="gap:6px">
            <span class="pill ${cls}">${label}</span>
            ${l.account ? `<span class="small muted">@${esc(l.account)}</span>` : ''}
            ${l.rule ? `<span class="small muted">· ${esc(l.rule)}</span>` : ''}
          </div>
          ${l.user ? `<div class="log-text"><strong>@${esc(l.user)}</strong> ${trig ? `(${trig})` : ''}: “${esc(l.incoming)}”</div>` : ''}
          ${l.reply ? `<div class="log-text muted">↳ DM: ${esc(l.reply)}</div>` : ''}
          ${l.publicReply ? `<div class="log-text muted">↳ Yorum cevabı: ${esc(l.publicReply)}</div>` : ''}
          ${l.message ? `<div class="log-text ${l.type === 'error' ? '' : 'muted'}">${esc(l.message)}</div>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function renderRules() {
  const el = $('#view-rules');
  const cards = S.rules
    .map((r) => {
      const kws = String(r.keywords || '').split(',').map((k) => k.trim()).filter(Boolean);
      return `
      <div class="card" data-testid="rule-${esc(r.name)}">
        <div class="rule-head">
          <label class="switch" title="Aç / kapat"><input type="checkbox" data-toggle-rule="${esc(r.id)}" ${r.active ? 'checked' : ''}><span></span></label>
          <div style="flex:1">
            <div class="rule-title">${esc(r.name)}</div>
            <div class="row small muted" style="gap:6px;margin-top:2px">
              <span class="pill accent">${esc(accName(r.accountId))}</span>
              <span>${r.type === 'comment' ? 'Gönderi yorumu gelince' : 'DM gelince'}</span>
              ${r.type === 'comment' ? `<span>· ${r.mediaScope === 'selected' ? `${(r.mediaIds || []).length} seçili gönderi` : 'tüm son gönderiler'}</span>` : ''}
            </div>
          </div>
          <button class="btn small" data-edit-rule="${esc(r.id)}">Düzenle</button>
          <button class="btn small danger" data-remove-rule="${esc(r.id)}">Sil</button>
        </div>
        <div class="rule-body">
          <div class="k">Anahtar kelime</div>
          <div class="chips">${kws.length ? kws.map((k) => `<span class="pill">${esc(k)}</span>`).join('') : '<span class="muted">Her mesaj</span>'}</div>
          <div class="k">Gönderilecek DM</div><div class="quote">${esc(r.dmText)}</div>
          ${r.type === 'comment' && r.publicReplyEnabled ? `<div class="k">Yorum cevabı</div><div class="quote">${esc(r.publicReplyText)}</div>` : ''}
          <div class="k">Tekrar</div><div>${r.oncePerUser ? 'Aynı kişiye bir kez' : 'Her eşleşmede'}</div>
        </div>
      </div>`;
    })
    .join('');

  el.innerHTML = `
    <div class="row"><h1>Otomasyonlar</h1><div class="spacer"></div>
      <button class="btn primary" id="new-rule" data-testid="new-rule" ${S.accounts.length ? '' : 'disabled'}>+ Yeni otomasyon</button></div>
    <p class="lead">Belirlediğiniz kelimeler yorumda veya DM'de geçtiğinde otomatik mesaj gönderilir.</p>
    ${
      !S.accounts.length
        ? `<div class="card empty">Önce bir Instagram hesabı bağlayın.<br><button class="btn primary" data-go="accounts">Hesap bağla</button></div>`
        : S.rules.length
          ? `<div class="stack">${cards}</div>`
          : `<div class="card empty">Henüz otomasyon yok.<br>Örneğin: biri gönderinize <b>SET</b> yazınca ona mix linkini DM'den gönderin.</div>`
    }`;
  const nb = $('#new-rule');
  if (nb) nb.onclick = () => openRuleDialog();
}

function renderAccounts() {
  $('#view-accounts').innerHTML = `
    <h1>Hesaplar</h1>
    <p class="lead">Instagram kullanıcı adınız ve şifrenizle giriş yapın. Birden fazla hesap ekleyebilirsiniz.</p>
    <div class="stack gap-below">${S.accounts.map((a) => accountCard(a, true)).join('')}</div>
    <form class="card" id="login-form" autocomplete="off">
      <h2>Hesap ekle</h2>
      <label class="field"><span>Instagram kullanıcı adı</span>
        <input type="text" id="ig-username" data-testid="ig-username" placeholder="örn. dj_engine" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Şifre</span>
        <input type="password" id="ig-password" data-testid="ig-password" placeholder="Instagram şifreniz"></label>
      <p class="hint">Şifreniz sadece giriş için kullanılır, bu uygulamada saklanmaz. Instagram doğrulama kodu isterse Instagram penceresi açılır.</p>
      <button class="btn primary" type="submit" id="login-btn" data-testid="login">Giriş yap</button>
    </form>`;
  $('#login-form').onsubmit = (e) => {
    e.preventDefault();
    login();
  };
}

async function login() {
  const btn = $('#login-btn');
  const user = $('#ig-username');
  const pass = $('#ig-password');
  btn.disabled = true;
  btn.textContent = 'Giriş yapılıyor…';
  try {
    const r = await run(() => api.login(user.value, pass.value));
    toast(`@${r.username} bağlandı`);
    render();
  } catch (_) {
  } finally {
    // Ekran yeniden çizilmiş olabilir; güncel öğelerle çalış
    if ($('#ig-password')) $('#ig-password').value = '';
    if ($('#login-btn')) {
      $('#login-btn').disabled = false;
      $('#login-btn').textContent = 'Giriş yap';
    }
  }
}

// "Yeniden giriş yap": kullanıcı adını doldurur, şifre alanına odaklanır
function relogin(username) {
  go('accounts');
  $('#ig-username').value = username;
  $('#ig-password').focus();
}

function renderActivity() {
  const items = logFilter === 'all' ? S.log : S.log.filter((l) => l.type === logFilter);
  const f = (k, label) => `<button class="btn small ${logFilter === k ? 'on' : ''}" data-filter="${k}">${label}</button>`;
  $('#view-activity').innerHTML = `
    <div class="row"><h1>Aktivite</h1><div class="spacer"></div><button class="btn small" id="clear-log">Kaydı temizle</button></div>
    <p class="lead">Gönderilen mesajlar, test kayıtları ve hatalar (son 300 kayıt).</p>
    <div class="filters" style="margin-bottom:12px">${f('all', 'Tümü')}${f('sent', 'Gönderilen')}${f('dry', 'Test')}${f('skip', 'Atlanan')}${f('error', 'Hatalar')}</div>
    <div class="card" data-testid="activity">${logList(items) || '<div class="empty">Kayıt yok.</div>'}</div>`;
  $('#clear-log').onclick = () => {
    if (confirm('Tüm aktivite kaydı silinsin mi?')) run(() => api.clearLog());
  };
}

function renderSettings() {
  const s = S.settings;
  const sw = (key, testid) => `<label class="switch"><input type="checkbox" data-setting="${key}" ${testid ? `data-testid="${testid}"` : ''} ${s[key] ? 'checked' : ''}><span></span></label>`;
  const num = (key, min, max) => `<input type="number" data-setting="${key}" min="${min}" max="${max}" value="${esc(s[key])}">`;
  $('#view-settings').innerHTML = `
    <h1>Ayarlar</h1><p class="lead">Varsayılan değerler kişisel kullanım için uygundur.</p>
    <div class="card">
      <div class="setting"><div class="desc"><div>Test modu</div><div class="muted small">Açıkken mesajlar gönderilmez, sadece Aktivite'ye yazılır. İlk denemelerde açık tutun.</div></div>${sw('dryRun', 'setting-dry')}</div>
      <div class="setting"><div class="desc"><div>Mac açılınca başlat</div><div class="muted small">Oturum açtığınızda uygulama menü çubuğunda otomatik başlar.</div></div>${sw('openAtLogin')}</div>
      <div class="setting"><div class="desc"><div>Bildirimler</div><div class="muted small">Otomatik mesaj gönderildiğinde bildirim göster.</div></div>${sw('notifications')}</div>
      <div class="setting"><div class="desc"><div>Kontrol aralığı (saniye)</div><div class="muted small">Yeni yorum ve DM'ler ne sıklıkla kontrol edilsin. 30–600 arası.</div></div>${num('pollSeconds', 30, 600)}</div>
      <div class="setting"><div class="desc"><div>Takip edilecek son gönderi sayısı</div><div class="muted small">"Tüm son gönderiler" seçeneğinde en yeni kaç gönderiye bakılsın. 1–25 arası.</div></div>${num('recentPosts', 1, 25)}</div>
      <div class="setting"><div class="desc"><div>Saatlik gönderim sınırı (hesap başına)</div><div class="muted small">Instagram'ın spam algılamasına takılmamak için. Fazlası sonraki saate kalır.</div></div>${num('maxSendsPerHour', 1, 200)}</div>
    </div>`;
  for (const input of document.querySelectorAll('[data-setting]')) {
    input.onchange = () => {
      const k = input.dataset.setting;
      const v = input.type === 'checkbox' ? input.checked : Number(input.value);
      if (k === 'dryRun' && !v && !confirm('Test modu kapatılsın mı? Bundan sonra eşleşen yorum ve DM\'lere gerçek mesaj gönderilecek.')) {
        input.checked = true;
        return;
      }
      run(() => api.updateSettings({ [k]: v }), 'Kaydedildi');
    };
  }
}

function renderHelp() {
  $('#view-help').innerHTML = `
    <h1>Kurulum Rehberi</h1>
    <p class="lead">İki dakikada hazır.</p>
    <div class="card"><ol class="steps">
      <li><b>Giriş yapın</b><a class="link" data-go="accounts">Hesaplar</a> sayfasında Instagram kullanıcı adınızı (e-posta değil) ve şifrenizi yazıp <i>"Giriş yap"</i>a basın. İkinci hesap için tekrarlayın.</li>
      <li><b>Otomasyon oluşturun</b><a class="link" data-go="rules">Otomasyonlar</a> sayfasında örneğin: gönderiye <code>SET</code> yazan kişiye linki DM'den gönder.</li>
      <li><b>Test modunda deneyin</b>Başka bir hesaptan gönderinize yorum yazın ve Aktivite sayfasında "Test" kaydını görün. Her şey doğruysa test modunu kapatın.</li>
    </ol></div>
    <div class="card" style="margin-top:16px">
      <h2>Bilmeniz gerekenler</h2>
      <ul class="muted" style="margin:0;padding-left:18px">
        <li><b>Risk:</b> Bu giriş yöntemi Instagram'ın resmî otomasyon yolu değildir. Instagram otomatik mesajları kurallarına aykırı sayıp hesabı geçici olarak kısıtlayabilir. Saatlik gönderim sınırını düşük tutun (Ayarlar).</li>
        <li>Instagram bazen "Bu siz misiniz?" diye doğrulama isteyebilir. O zaman hesap "Yeniden giriş gerekli" olur; <i>"Yeniden giriş yap"</i>a basıp şifrenizi tekrar girmeniz yeterli.</li>
        <li>Otomasyon bu Mac açık ve uygulama çalışırken işler. Mac uykudaysa, uyandığında son 7 gün içindeki yorumlara cevap verilir.</li>
        <li>Mesajlarda <code>{username}</code> yazarsanız kişinin kullanıcı adıyla değiştirilir. Birden fazla alternatif için cevapları ayrı satırda <code>---</code> ile ayırın, rastgele biri seçilir.</li>
      </ul>
    </div>`;
}

// ---------------- Otomasyon düzenleyici ----------------
let mediaCache = {};

async function openRuleDialog(rule) {
  const d = $('#rule-dialog');
  const r = rule
    ? JSON.parse(JSON.stringify(rule))
    : { name: '', accountId: S.accounts[0].id, type: 'comment', keywords: '', mediaScope: 'all', mediaIds: [], dmText: '', publicReplyEnabled: false, publicReplyText: '', oncePerUser: true, active: true };

  const accOpts = S.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === r.accountId ? 'selected' : ''}>@${esc(a.username)}</option>`).join('');
  d.innerHTML = `
    <form method="dialog" id="rule-form">
      <div class="d-head"><h2 style="margin:0">${rule ? 'Otomasyonu düzenle' : 'Yeni otomasyon'}</h2></div>
      <div class="d-body">
        <label class="field"><span>Otomasyon adı</span><input type="text" name="name" data-testid="rule-name" value="${esc(r.name)}" placeholder="Örn. Set linki gönder"></label>
        <label class="field"><span>Hesap</span><select name="accountId" data-testid="rule-account">${accOpts}</select></label>
        <div class="field"><span style="font-weight:600;font-size:13px">Ne olunca?</span>
          <div class="radio-row">
            <label><input type="radio" name="type" value="comment" ${r.type === 'comment' ? 'checked' : ''}> Gönderime yorum gelince</label>
            <label><input type="radio" name="type" value="dm" data-testid="type-dm" ${r.type === 'dm' ? 'checked' : ''}> Bana DM gelince</label>
          </div>
        </div>
        <label class="field"><span>Anahtar kelimeler <span class="hint">— virgülle ayırın. Boş bırakırsanız her ${r.type === 'dm' ? 'mesaja' : 'yoruma'} cevap verilir.</span></span>
          <input type="text" name="keywords" data-testid="rule-keywords" value="${esc(r.keywords)}" placeholder="set, link, mix"></label>
        <div id="media-section" class="field ${r.type === 'comment' ? '' : 'hidden'}">
          <span style="font-weight:600;font-size:13px">Hangi gönderilerde?</span>
          <div class="radio-row">
            <label><input type="radio" name="mediaScope" value="all" ${r.mediaScope !== 'selected' ? 'checked' : ''}> Tüm son gönderiler</label>
            <label><input type="radio" name="mediaScope" value="selected" ${r.mediaScope === 'selected' ? 'checked' : ''}> Seçtiğim gönderiler</label>
          </div>
          <div id="media-picker" class="${r.mediaScope === 'selected' ? '' : 'hidden'}"><div class="muted small" id="media-status">Gönderiler yükleniyor…</div><div class="media-grid" id="media-grid"></div></div>
        </div>
        <label class="field"><span>Gönderilecek DM <span class="hint">— <code>{username}</code> kişinin adıyla değişir. Alternatifler için ayrı satırda <code>---</code></span></span>
          <textarea name="dmText" data-testid="rule-dm" rows="4" placeholder="Selam {username}! İstediğin link: https://…">${esc(r.dmText)}</textarea></label>
        <div id="public-section" class="${r.type === 'comment' ? '' : 'hidden'}">
          <label class="check"><input type="checkbox" name="publicReplyEnabled" ${r.publicReplyEnabled ? 'checked' : ''}> Yoruma herkese açık cevap da yaz</label>
          <label class="field ${r.publicReplyEnabled ? '' : 'hidden'}" id="public-field"><span>Yorum cevabı <span class="hint">— örn. "DM'ini kontrol et 🔥". Alternatifler için <code>---</code></span></span>
            <textarea name="publicReplyText" rows="2">${esc(r.publicReplyText)}</textarea></label>
        </div>
        <label class="check"><input type="checkbox" name="oncePerUser" ${r.oncePerUser ? 'checked' : ''}> Aynı kişiye bu otomasyondan sadece bir kez gönder</label>
        <label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Aktif</label>
      </div>
      <div class="d-foot">
        <span class="error-text" id="rule-error"></span>
        <button class="btn" value="cancel" type="button" id="rule-cancel">Vazgeç</button>
        <button class="btn primary" type="submit" data-testid="rule-save">Kaydet</button>
      </div>
    </form>`;

  const form = $('#rule-form');
  const selected = new Set(r.mediaIds || []);

  const sync = () => {
    const type = form.type.value;
    $('#media-section').classList.toggle('hidden', type !== 'comment');
    $('#public-section').classList.toggle('hidden', type !== 'comment');
    $('#public-field').classList.toggle('hidden', !form.publicReplyEnabled.checked);
    const sel = type === 'comment' && form.mediaScope.value === 'selected';
    $('#media-picker').classList.toggle('hidden', !sel);
    if (sel) loadMedia(form.accountId.value, selected);
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'accountId') selected.clear();
    sync();
  });
  sync();

  $('#rule-cancel').onclick = () => d.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      ...r,
      name: form.name.value.trim(),
      accountId: form.accountId.value,
      type: form.type.value,
      keywords: form.keywords.value.trim(),
      mediaScope: form.mediaScope.value,
      mediaIds: [...selected],
      dmText: form.dmText.value.trim(),
      publicReplyEnabled: form.publicReplyEnabled.checked,
      publicReplyText: form.publicReplyText.value.trim(),
      oncePerUser: form.oncePerUser.checked,
      active: form.active.checked,
    };
    try {
      await api.saveRule(data);
      d.close();
      toast('Otomasyon kaydedildi');
    } catch (err) {
      $('#rule-error').textContent = err.message;
    }
  };
  d.showModal();
}

async function loadMedia(accountId, selected) {
  const grid = $('#media-grid');
  const status = $('#media-status');
  const draw = (items) => {
    status.textContent = items.length ? 'Otomasyonun çalışacağı gönderileri seçin:' : 'Bu hesapta gönderi bulunamadı.';
    grid.innerHTML = items
      .map((m) => {
        const img = m.thumbnail_url || m.media_url;
        return `<div class="media ${selected.has(m.id) ? 'sel' : ''}" data-media="${esc(m.id)}" title="${esc(m.caption || '')}">
          ${img ? `<img src="${esc(img)}" alt="">` : ''}<div class="cap">${esc((m.caption || 'Gönderi').slice(0, 40))}</div></div>`;
      })
      .join('');
    for (const el of grid.querySelectorAll('[data-media]')) {
      el.onclick = () => {
        const id = el.dataset.media;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        el.classList.toggle('sel');
      };
    }
  };
  if (mediaCache[accountId]) return draw(mediaCache[accountId]);
  try {
    mediaCache[accountId] = await api.media(accountId);
    draw(mediaCache[accountId]);
  } catch (e) {
    status.textContent = `Gönderiler alınamadı: ${e.message}`;
  }
}

// ---------------- Genel ----------------
function render() {
  if (!S) return;
  const s = S.settings;
  const line = $('#status-line');
  line.textContent = !s.running ? 'Duraklatıldı' : s.dryRun ? 'Test modu' : 'Çalışıyor';
  line.className = `brand-sub ${!s.running ? 'off' : s.dryRun ? 'test' : 'on'}`;
  $('#dry-banner').classList.toggle('hidden', !s.dryRun);
  $('#version').textContent = `Sürüm ${S.version}`;
  ({ overview: renderOverview, rules: renderRules, accounts: renderAccounts, activity: renderActivity, settings: renderSettings, help: renderHelp })[view]();
}

function go(v) {
  view = v;
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('active', b.dataset.view === v);
  for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('hidden', sec.id !== `view-${v}`);
  render();
  $('main').scrollTop = 0;
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-view],[data-go],[data-ext],[data-filter],[data-edit-rule],[data-remove-rule],[data-remove-account],[data-relogin]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.relogin) relogin(ds.relogin);
  else if (ds.view) go(ds.view);
  else if (ds.go) go(ds.go);
  else if (ds.ext) run(() => api.openExternal(ds.ext)).catch(() => {});
  else if (ds.filter) {
    logFilter = ds.filter;
    render();
  } else if (ds.editRule) openRuleDialog(S.rules.find((r) => r.id === ds.editRule));
  else if (ds.removeRule) {
    const r = S.rules.find((x) => x.id === ds.removeRule);
    if (confirm(`"${r.name}" otomasyonu silinsin mi?`)) run(() => api.removeRule(r.id), 'Silindi').catch(() => {});
  } else if (ds.removeAccount) {
    const a = S.accounts.find((x) => x.id === ds.removeAccount);
    if (confirm(`@${a.username} hesabı ve bu hesaba ait tüm otomasyonlar kaldırılsın mı?`)) run(() => api.removeAccount(a.id), 'Hesap kaldırıldı').catch(() => {});
  }
});

document.addEventListener('change', (e) => {
  const id = e.target.dataset && e.target.dataset.toggleRule;
  if (!id) return;
  const r = S.rules.find((x) => x.id === id);
  run(() => api.saveRule({ ...r, active: e.target.checked }));
});

$('#dry-off').onclick = () => {
  if (confirm('Test modu kapatılsın mı? Bundan sonra eşleşen yorum ve DM\'lere gerçek mesaj gönderilecek.'))
    run(() => api.updateSettings({ dryRun: false }), 'Gerçek gönderim açıldı').catch(() => {});
};

api.onState((s) => {
  S = s;
  // Kullanıcı form doldururken ekranı yeniden çizip yazdıklarını silmeyelim
  const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && view !== 'overview';
  if (!typing) render();
  else {
    const s2 = S.settings;
    $('#dry-banner').classList.toggle('hidden', !s2.dryRun);
  }
});

api.state().then((s) => {
  S = s;
  render();
});

// Genel bakıştaki "sonraki kontrol" sayacını canlı tut
setInterval(() => {
  if (view === 'overview' && S && !$('#rule-dialog').open) renderOverview();
}, 5000);
