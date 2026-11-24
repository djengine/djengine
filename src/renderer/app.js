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
      <div class="card stat"><div class="num">${S.contactsTotal || 0}</div><div class="lbl">Toplanan kişi</div></div>
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
  gate: ['warn', 'Takip istendi'],
  lead: ['ok', 'Kişi kaydedildi'],
};

const TYPE_LABEL = { comment: 'Gönderi yorumu gelince', dm: 'DM gelince', story: 'Hikâyeye cevap gelince' };
const TRIG_LABEL = { comment: 'yorum', dm: 'DM', story: 'hikâye cevabı' };
function scopeLabel(r) {
  if (r.type !== 'comment') return '';
  if (r.mediaScope === 'selected') return `${(r.mediaIds || []).length} seçili gönderi`;
  if (r.mediaScope === 'reels') return 'sadece Reels';
  if (r.mediaScope === 'since') return `${r.sinceDate ? new Date(r.sinceDate).toLocaleDateString('tr-TR') : '?'} sonrası gönderiler`;
  return 'tüm son gönderiler';
}

function logList(items) {
  return items
    .map((l) => {
      const [cls, label] = LOG_META[l.type] || ['', l.type];
      const trig = TRIG_LABEL[l.trigger] || '';
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

function ruleStats(r) {
  const st = (S.stats || {})[r.id] || {};
  const item = (n, label, id) => `<div class="rs"><b data-testid="${id}-${esc(r.name)}">${n || 0}</b><span>${label}</span></div>`;
  return `<div class="rule-stats">
    ${item(st.triggered, 'tetiklenme', 'st-triggered')}
    ${item(st.sent, 'gönderilen', 'st-sent')}
    ${item(st.dry, 'test kaydı', 'st-dry')}
    ${r.followGate ? item(st.gated, 'takip istendi', 'st-gated') + item(st.unlocked, 'takip edip aldı', 'st-unlocked') : ''}
    ${st.errors ? item(st.errors, 'hata', 'st-errors') : ''}
  </div>`;
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
              <span>${TYPE_LABEL[r.type] || ''}</span>
              ${r.type === 'comment' ? `<span>· ${esc(scopeLabel(r))}</span>` : ''}
              ${r.followGate ? '<span class="pill warn">Takip şartı</span>' : ''}
              ${r.replyMode === 'ai' ? '<span class="pill accent">✨ Yapay zekâ</span>' : ''}
            </div>
          </div>
          <button class="btn small" data-edit-rule="${esc(r.id)}">Düzenle</button>
          <button class="btn small danger" data-remove-rule="${esc(r.id)}">Sil</button>
        </div>
        <div class="rule-body">
          <div class="k">Anahtar kelime</div>
          <div class="chips">${kws.length ? kws.map((k) => `<span class="pill">${esc(k)}</span>`).join('') : '<span class="muted">Her mesaj</span>'}</div>
          ${
            r.replyMode === 'ai'
              ? `<div class="k">Yapay zekâ talimatı</div><div class="quote">${esc(r.aiInstructions || '(talimat yok)')}</div>`
              : `<div class="k">Gönderilecek DM</div><div class="quote">${esc(r.dmText)}</div>`
          }
          ${r.followGate ? `<div class="k">Takip etmeyene</div><div class="quote">${esc(r.followPrompt || 'Varsayılan "önce takip et" mesajı')}</div>` : ''}
          ${r.type === 'comment' && r.publicReplyEnabled ? `<div class="k">Yorum cevabı</div><div class="quote">${esc(r.publicReplyText)}</div>` : ''}
          <div class="k">Tekrar</div><div>${r.oncePerUser ? 'Aynı kişiye bir kez' : 'Her eşleşmede'}</div>
        </div>
        ${ruleStats(r)}
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
      <li><b>Ücretsiz yapay zekâ (isteğe bağlı)</b><a class="link" data-ext="https://ollama.com/download">ollama.com</a>'dan Ollama'yı indirip açın, sonra <a class="link" data-go="ai">Yapay Zekâ</a> sayfasında "Modeli indir"e basın. Hesap analizi, içerik planı ve DM'lere otomatik cevap için kullanılır; ücretsizdir ve Mac'inizde çalışır.</li>
    </ol></div>
    <div class="card" style="margin-top:16px">
      <h2>Neler yapabilirsiniz?</h2>
      <ul class="muted" style="margin:0;padding-left:18px">
        <li><b>Yorum → DM:</b> gönderinize anahtar kelime yazana otomatik DM. Tüm gönderiler, sadece Reels, belirli tarihten sonrakiler veya seçtiğiniz gönderiler.</li>
        <li><b>Hikâye cevabı → DM</b> ve <b>DM → otomatik cevap</b>.</li>
        <li><b>Takip şartı:</b> mesaj sadece takipçilere gider; takip etmeyene "önce takip et" mesajı gider, takip edip yazınca asıl mesaj otomatik gönderilir.</li>
        <li><b>Kişiler:</b> DM'de paylaşılan e-posta/telefon otomatik kaydedilir, Excel'e aktarılır.</li>
        <li><b>Yapay zekâ:</b> otomasyon cevaplarını yapay zekâ yazabilir; Otomatik pilot tüm DM'lere sizin yerinize cevap verir.</li>
      </ul>
    </div>
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

// ---------------- Kişiler ----------------
let contactQuery = '';
function renderContacts() {
  const q = contactQuery.toLowerCase();
  const list = (S.contacts || []).filter(
    (c) => !q || [c.username, c.email, c.phone, (c.tags || []).join(' ')].some((v) => String(v || '').toLowerCase().includes(q))
  );
  const withInfo = (S.contacts || []).filter((c) => c.email || c.phone).length;
  $('#view-contacts').innerHTML = `
    <div class="row"><h1>Kişiler</h1><div class="spacer"></div>
      <button class="btn" id="export-contacts" data-testid="export-contacts" ${S.contactsTotal ? '' : 'disabled'}>Excel'e aktar (CSV)</button></div>
    <p class="lead">Otomasyonlarınızla etkileşime giren herkes burada. DM'de e-posta veya telefon paylaşanların bilgisi otomatik kaydedilir.</p>
    <div class="cards" style="margin-bottom:16px">
      <div class="card stat"><div class="num" data-testid="contacts-total">${S.contactsTotal || 0}</div><div class="lbl">Toplam kişi</div></div>
      <div class="card stat"><div class="num" data-testid="contacts-leads">${withInfo}</div><div class="lbl">E-posta / telefon veren</div></div>
    </div>
    <input type="text" id="contact-search" data-testid="contact-search" placeholder="Ara: kullanıcı adı, e-posta, etiket…" value="${esc(contactQuery)}" style="margin-bottom:12px">
    <div class="card table-wrap">${
      list.length
        ? `<table class="table"><thead><tr><th>Kişi</th><th>Hesap</th><th>E-posta</th><th>Telefon</th><th>Etiketler</th><th>Son</th></tr></thead><tbody>
          ${list
            .slice(0, 500)
            .map(
              (c) => `<tr data-testid="contact-${esc(c.username)}">
                <td><strong>${c.username ? '@' + esc(c.username) : esc(c.userId)}</strong> <span class="small muted">· ${c.interactions || 0} etkileşim</span>${c.lastMessage ? `<div class="small muted ellipsis">${esc(c.lastMessage)}</div>` : ''}</td>
                <td>${esc(accName(c.accountId))}</td><td>${esc(c.email || '—')}</td><td>${esc(c.phone || '—')}</td>
                <td>${(c.tags || []).map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</td>
                <td class="small muted nowrap">${timeAgo(c.lastSeen)}</td></tr>`
            )
            .join('')}</tbody></table>`
        : '<div class="empty">Henüz kişi yok. Otomasyonlarınız çalıştıkça burası dolar.</div>'
    }</div>`;
  $('#contact-search').oninput = (e) => {
    contactQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderContacts();
    const el = $('#contact-search');
    el.focus();
    el.setSelectionRange(pos, pos);
  };
  $('#export-contacts').onclick = async () => {
    const file = await run(() => api.exportContacts()).catch(() => null);
    if (file) toast('Kişiler kaydedildi');
  };
}

// ---------------- Yapay Zekâ ----------------
const ai = { status: null, checking: false, pull: null, account: null, messages: [], busy: false, autopilotDraft: null };

// Yapay zekâ cevabını güvenli biçimde (önce kaçışlayıp) basit biçimlendirmeyle gösterir
function mdLite(text) {
  return esc(text)
    .split('\n')
    .map((line) => {
      let l = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^#{1,4}\s/.test(l)) return `<div class="md-h">${l.replace(/^#{1,4}\s/, '')}</div>`;
      if (/^\s*[-*•]\s/.test(l)) return `<div class="md-li">• ${l.replace(/^\s*[-*•]\s/, '')}</div>`;
      if (/^\s*\d+[.)]\s/.test(l)) return `<div class="md-li">${l.trim()}</div>`;
      return l.trim() ? `<div>${l}</div>` : '<div class="md-gap"></div>';
    })
    .join('');
}

async function checkAi() {
  if (ai.checking) return;
  ai.checking = true;
  try {
    ai.status = await api.aiStatus();
  } catch (_) {
    ai.status = { running: false };
  } finally {
    ai.checking = false;
  }
  if (view === 'ai') renderAI();
}

const AI_ACTIONS = [
  ['📊 Hesabımı analiz et', 'Hesabımı analiz et: hangi içerikler iyi gidiyor, hangileri gitmiyor, neden? Sonra büyümek için bu hafta yapmam gereken en önemli 5 şeyi sırala.'],
  ['📅 Haftalık içerik planı', 'Önümüzdeki 7 gün için içerik planı hazırla. Her gün için: format (Reels/karusel/hikâye), konu, ilk 3 saniyelik kanca, kısa açıklama metni, 3-5 hashtag ve önerilen paylaşım saati.'],
  ['✍️ Gönderi metni yaz', 'Şu konu için 3 farklı gönderi açıklaması ve hashtag önerisi yaz: '],
  ['💡 Bio öner', 'Biyografim için 3 farklı, kısa ve takip ettiren öneri yaz. Her birine kısa bir gerekçe ekle.'],
  ['🤖 Otomasyon öner', 'Hesabıma uygun 3 yorum→DM otomasyonu öner: hangi gönderide, hangi anahtar kelime, gönderilecek DM metni ve takip şartı kullanılmalı mı?'],
  ['📈 Büyüme stratejisi', '30 günlük büyüme stratejisi hazırla: haftalık hedefler, içerik karması, etkileşim rutini ve ölçmem gereken metrikler.'],
];

function renderAI() {
  const st = ai.status;
  if (!st && !ai.checking) checkAi();
  if (!ai.account || !S.accounts.some((a) => a.id === ai.account)) ai.account = S.accounts[0] && S.accounts[0].id;
  const model = (S.ai && S.ai.model) || '';
  const modelOpts = ((S.ai && S.ai.models) || [])
    .map((m) => `<option value="${esc(m.name)}" ${m.name === model ? 'selected' : ''}>${esc(m.label)}</option>`)
    .join('');
  const ready = st && st.running && st.installed;

  let statusHtml;
  if (!st) statusHtml = '<div class="muted">Yapay zekâ kontrol ediliyor…</div>';
  else if (!st.running)
    statusHtml = `<div class="row" style="gap:8px"><span class="pill err">Kurulu değil / kapalı</span><strong>Ücretsiz yapay zekâ için Ollama gerekli</strong></div>
      <ol class="steps compact">
        <li><b>Ollama'yı indirin</b><a class="link" data-ext="https://ollama.com/download">ollama.com/download</a> adresinden Mac sürümünü indirip Uygulamalar'a sürükleyin (ücretsiz).</li>
        <li><b>Ollama'yı açın</b>Menü çubuğunda lama simgesi görünür. Hesap açmanız gerekmez.</li>
        <li><b>Buraya dönün</b><button class="btn small" data-ai-check data-testid="ai-check">Tekrar kontrol et</button></li>
      </ol>`;
  else if (!st.installed)
    statusHtml = `<div class="row" style="gap:8px"><span class="pill warn">Model indirilmeli</span><strong>Son adım: yapay zekâ modelini indirin (bir kez)</strong></div>
      <div class="row" style="gap:8px;margin-top:10px"><select id="ai-model" data-testid="ai-model">${modelOpts}</select>
        <button class="btn primary" id="ai-pull" data-testid="ai-pull" ${ai.pull ? 'disabled' : ''}>${ai.pull ? 'İndiriliyor…' : 'Modeli indir'}</button></div>
      ${ai.pull ? `<div class="progress"><div style="width:${ai.pull.pct || 0}%"></div></div><div class="small muted">${ai.pull.pct != null ? ai.pull.pct + '%' : ''} ${esc(ai.pull.status || '')}</div>` : ''}`;
  else
    statusHtml = `<div class="row" style="gap:8px"><span class="pill ok" data-testid="ai-ready">Hazır</span><strong>Ücretsiz yapay zekâ çalışıyor</strong><span class="spacer"></span>
      <select id="ai-model" data-testid="ai-model">${modelOpts}</select></div>
      <div class="small muted" style="margin-top:6px">Model Mac'inizde çalışır; verileriniz dışarı gönderilmez. Intel Mac'te cevaplar birkaç saniye ile bir dakika arası sürebilir.</div>`;

  const accOpts = S.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === ai.account ? 'selected' : ''}>@${esc(a.username)}</option>`).join('');
  const pilot = S.rules.find((r) => r.autopilot && r.accountId === ai.account);
  const pilotText = ai.autopilotDraft != null ? ai.autopilotDraft : (pilot && pilot.aiInstructions) || '';
  const msgs = ai.messages
    .map((m) => `<div class="bubble ${m.role}" data-testid="ai-msg-${m.role}">${m.role === 'assistant' ? mdLite(m.content) : esc(m.content)}</div>`)
    .join('');

  $('#view-ai').innerHTML = `
    <h1>✨ Yapay Zekâ</h1>
    <p class="lead">Hesabınızı analiz eden, içerik planlayan, metin yazan ve DM'lere sizin yerinize cevap veren ücretsiz asistan.</p>
    <div class="card" style="margin-bottom:16px" id="ai-status">${statusHtml}</div>
    ${
      !S.accounts.length
        ? '<div class="card empty">Önce bir Instagram hesabı bağlayın.<br><button class="btn primary" data-go="accounts">Hesap bağla</button></div>'
        : `
    <div class="row" style="gap:8px;margin-bottom:12px"><span class="muted">Hesap:</span><select id="ai-account" data-testid="ai-account">${accOpts}</select></div>
    <div class="card" style="margin-bottom:16px">
      <h2>Asistan</h2>
      <div class="ai-actions">${AI_ACTIONS.map(([label], i) => `<button class="btn small" data-ai-action="${i}" ${ready && !ai.busy ? '' : 'disabled'}>${label}</button>`).join('')}</div>
      <div class="chat" id="ai-chat">${msgs || '<div class="muted small">Yukarıdaki hazır komutlardan birine basın ya da aşağıya sorunuzu yazın. Asistan hesabınızın son gönderilerini, takipçi sayınızı ve otomasyon istatistiklerinizi görür.</div>'}
        ${ai.busy ? '<div class="bubble assistant muted" data-testid="ai-thinking">Düşünüyor…</div>' : ''}</div>
      <form id="ai-form" class="row" style="gap:8px;margin-top:10px">
        <textarea id="ai-input" data-testid="ai-input" rows="2" placeholder="Örn. Bu hafta hangi saatte Reels paylaşmalıyım?" ${ready ? '' : 'disabled'}></textarea>
        <button class="btn primary" type="submit" data-testid="ai-send" ${ready && !ai.busy ? '' : 'disabled'}>Gönder</button>
      </form>
      ${ai.messages.length ? '<button class="btn small" id="ai-clear" style="margin-top:8px">Sohbeti temizle</button>' : ''}
    </div>
    <div class="card">
      <div class="row"><h2 style="margin:0">🤖 Otomatik pilot</h2><span class="spacer"></span>
        <label class="switch" title="Aç / kapat"><input type="checkbox" id="pilot-on" data-testid="pilot-on" ${pilot && pilot.active ? 'checked' : ''}><span></span></label></div>
      <p class="muted" style="margin-top:6px">Açıkken bu hesaba gelen <b>tüm DM'lere</b> yapay zekâ sizin yerinize cevap verir. Ne söyleyeceğini aşağıya yazın. Test modu açıksa cevaplar gönderilmez, Aktivite'ye yazılır.</p>
      <textarea id="pilot-text" data-testid="pilot-text" rows="4" placeholder="Örn. Ben DJ'im. Düğün ve özel etkinlik paketleri 15.000 TL'den başlar. Müsaitlik için tarih ve şehir sor. Rezervasyon: booking@ornek.com. Kısa ve samimi yaz.">${esc(pilotText)}</textarea>
      <button class="btn primary" id="pilot-save" data-testid="pilot-save" style="margin-top:8px">Kaydet</button>
    </div>`
    }`;

  const sel = $('#ai-model');
  if (sel) sel.onchange = () => run(() => api.updateSettings({ aiModel: sel.value }), 'Model değiştirildi').then(() => checkAi()).catch(() => {});
  const pullBtn = $('#ai-pull');
  if (pullBtn)
    pullBtn.onclick = async () => {
      ai.pull = { pct: 0, status: 'başlıyor' };
      renderAI();
      try {
        await run(() => api.aiPull());
        toast('Model indirildi, yapay zekâ hazır');
      } catch (_) {
      } finally {
        ai.pull = null;
        checkAi();
      }
    };
  const accSel = $('#ai-account');
  if (accSel)
    accSel.onchange = () => {
      ai.account = accSel.value;
      ai.messages = [];
      ai.autopilotDraft = null;
      renderAI();
    };
  const form = $('#ai-form');
  if (form)
    form.onsubmit = (e) => {
      e.preventDefault();
      askAi($('#ai-input').value);
    };
  const input = $('#ai-input');
  if (input)
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        askAi(input.value);
      }
    };
  const clear = $('#ai-clear');
  if (clear)
    clear.onclick = () => {
      ai.messages = [];
      renderAI();
    };
  const pText = $('#pilot-text');
  if (pText) pText.oninput = () => (ai.autopilotDraft = pText.value);
  const savePilot = (enabled) =>
    run(() => api.aiAutopilot(ai.account, enabled, $('#pilot-text').value), enabled ? 'Otomatik pilot açık' : 'Otomatik pilot kapalı')
      .then(() => (ai.autopilotDraft = null))
      .catch(() => {});
  const pOn = $('#pilot-on');
  if (pOn) pOn.onchange = () => savePilot(pOn.checked);
  const pSave = $('#pilot-save');
  if (pSave) pSave.onclick = () => savePilot(!!(pOn && pOn.checked));
  const chat = $('#ai-chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

async function askAi(text) {
  text = String(text || '').trim();
  if (!text || ai.busy) return;
  ai.messages.push({ role: 'user', content: text });
  ai.busy = true;
  renderAI();
  try {
    const answer = await api.aiChat(ai.account, ai.messages);
    ai.messages.push({ role: 'assistant', content: answer });
  } catch (e) {
    ai.messages.pop();
    toast(e.message, true);
  } finally {
    ai.busy = false;
    if (view === 'ai') renderAI();
  }
}

api.onAiProgress((p) => {
  if (!ai.pull) ai.pull = {};
  if (p.pct != null) ai.pull.pct = p.pct;
  ai.pull.status = p.status === 'success' ? 'tamamlandı' : p.status;
  if (view === 'ai') renderAI();
});

// ---------------- Otomasyon düzenleyici ----------------
let mediaCache = {};

async function openRuleDialog(rule) {
  const d = $('#rule-dialog');
  const r = rule
    ? JSON.parse(JSON.stringify(rule))
    : {
        name: '', accountId: S.accounts[0].id, type: 'comment', keywords: '', mediaScope: 'all', mediaIds: [], sinceDate: '',
        dmText: '', replyMode: 'fixed', aiInstructions: '', followGate: false, followPrompt: '',
        publicReplyEnabled: false, publicReplyText: '', oncePerUser: true, active: true,
      };
  const chk = (cond) => (cond ? 'checked' : '');
  const accOpts = S.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === r.accountId ? 'selected' : ''}>@${esc(a.username)}</option>`).join('');
  d.innerHTML = `
    <form method="dialog" id="rule-form">
      <div class="d-head"><h2 style="margin:0">${rule ? 'Otomasyonu düzenle' : 'Yeni otomasyon'}</h2></div>
      <div class="d-body">
        <label class="field"><span>Otomasyon adı</span><input type="text" name="name" data-testid="rule-name" value="${esc(r.name)}" placeholder="Örn. Set linki gönder"></label>
        <label class="field"><span>Hesap</span><select name="accountId" data-testid="rule-account">${accOpts}</select></label>
        <div class="field"><span style="font-weight:600;font-size:13px">Ne olunca?</span>
          <div class="radio-row">
            <label><input type="radio" name="type" value="comment" ${chk(r.type === 'comment')}> Gönderime yorum gelince</label>
            <label><input type="radio" name="type" value="dm" data-testid="type-dm" ${chk(r.type === 'dm')}> Bana DM gelince</label>
            <label><input type="radio" name="type" value="story" data-testid="type-story" ${chk(r.type === 'story')}> Hikâyeme cevap gelince</label>
          </div>
        </div>
        <label class="field"><span>Anahtar kelimeler <span class="hint">— virgülle ayırın. Boş bırakırsanız her mesaja/yoruma cevap verilir.</span></span>
          <input type="text" name="keywords" data-testid="rule-keywords" value="${esc(r.keywords)}" placeholder="set, link, mix"></label>
        <div id="media-section" class="field">
          <span style="font-weight:600;font-size:13px">Hangi gönderilerde?</span>
          <div class="radio-row">
            <label><input type="radio" name="mediaScope" value="all" ${chk(!['selected', 'reels', 'since'].includes(r.mediaScope))}> Tüm son gönderiler</label>
            <label><input type="radio" name="mediaScope" value="reels" data-testid="scope-reels" ${chk(r.mediaScope === 'reels')}> Sadece Reels</label>
            <label><input type="radio" name="mediaScope" value="since" data-testid="scope-since" ${chk(r.mediaScope === 'since')}> Şu tarihten sonrakiler</label>
            <label><input type="radio" name="mediaScope" value="selected" ${chk(r.mediaScope === 'selected')}> Seçtiğim gönderiler</label>
          </div>
          <label class="field" id="since-field"><span>Başlangıç tarihi</span><input type="date" name="sinceDate" data-testid="rule-since" value="${esc(r.sinceDate || '')}"></label>
          <div id="media-picker"><div class="muted small" id="media-status">Gönderiler yükleniyor…</div><div class="media-grid" id="media-grid"></div></div>
        </div>

        <div class="field"><span style="font-weight:600;font-size:13px">Cevabı kim yazsın?</span>
          <div class="radio-row">
            <label><input type="radio" name="replyMode" value="fixed" ${chk(r.replyMode !== 'ai')}> Hazır mesajım</label>
            <label><input type="radio" name="replyMode" value="ai" data-testid="mode-ai" ${chk(r.replyMode === 'ai')}> ✨ Yapay zekâ yazsın</label>
          </div>
        </div>
        <label class="field" id="dm-field"><span>Gönderilecek DM <span class="hint">— <code>{username}</code> kişinin adıyla değişir. Alternatifler için ayrı satırda <code>---</code></span></span>
          <textarea name="dmText" data-testid="rule-dm" rows="4" placeholder="Selam {username}! İstediğin link: https://…">${esc(r.dmText)}</textarea></label>
        <label class="field" id="ai-field"><span>Yapay zekâya talimat <span class="hint">— işletmeniz, fiyatlar, linkler, üslup. Yapay zekâ sadece bunlara dayanarak cevap verir.</span></span>
          <textarea name="aiInstructions" data-testid="rule-ai" rows="4" placeholder="Örn. DJ hizmeti veriyorum. Düğün paketi 15.000 TL'den başlar. Rezervasyon için mail: booking@…. Samimi ve kısa yaz.">${esc(r.aiInstructions || '')}</textarea></label>

        <label class="check"><input type="checkbox" name="followGate" data-testid="rule-gate" ${chk(r.followGate)}> Takip şartı: sadece beni takip edenlere gönder</label>
        <label class="field" id="gate-field"><span>Takip etmeyene gidecek mesaj <span class="hint">— boş bırakırsanız hazır bir mesaj kullanılır. Kişi takip edip size yazınca asıl mesaj otomatik gider.</span></span>
          <textarea name="followPrompt" data-testid="rule-gate-text" rows="2" placeholder="Selam {username}! Linki gönderebilmem için önce hesabımı takip et, sonra bana &quot;tamam&quot; yaz 🙌">${esc(r.followPrompt || '')}</textarea></label>

        <div id="public-section">
          <label class="check"><input type="checkbox" name="publicReplyEnabled" ${chk(r.publicReplyEnabled)}> Yoruma herkese açık cevap da yaz</label>
          <label class="field" id="public-field"><span>Yorum cevabı <span class="hint">— örn. "DM'ini kontrol et 🔥". Alternatifler için <code>---</code></span></span>
            <textarea name="publicReplyText" rows="2">${esc(r.publicReplyText)}</textarea></label>
        </div>
        <label class="check"><input type="checkbox" name="oncePerUser" ${chk(r.oncePerUser)}> Aynı kişiye bu otomasyondan sadece bir kez gönder</label>
        <label class="check"><input type="checkbox" name="active" ${chk(r.active)}> Aktif</label>
      </div>
      <div class="d-foot">
        <span class="error-text" id="rule-error"></span>
        <button class="btn" value="cancel" type="button" id="rule-cancel">Vazgeç</button>
        <button class="btn primary" type="submit" data-testid="rule-save">Kaydet</button>
      </div>
    </form>`;

  const form = $('#rule-form');
  const selected = new Set(r.mediaIds || []);
  const hide = (sel, cond) => $(sel).classList.toggle('hidden', !!cond);

  const sync = () => {
    const type = form.type.value;
    const scope = form.mediaScope.value;
    const ai = form.replyMode.value === 'ai';
    hide('#media-section', type !== 'comment');
    hide('#public-section', type !== 'comment');
    hide('#public-field', !form.publicReplyEnabled.checked);
    hide('#since-field', scope !== 'since');
    hide('#dm-field', ai);
    hide('#ai-field', !ai);
    hide('#gate-field', !form.followGate.checked);
    const sel = type === 'comment' && scope === 'selected';
    hide('#media-picker', !sel);
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
      sinceDate: form.sinceDate.value,
      replyMode: form.replyMode.value,
      dmText: form.dmText.value.trim(),
      aiInstructions: form.aiInstructions.value.trim(),
      followGate: form.followGate.checked,
      followPrompt: form.followPrompt.value.trim(),
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
  ({ overview: renderOverview, rules: renderRules, ai: renderAI, contacts: renderContacts, accounts: renderAccounts, activity: renderActivity, settings: renderSettings, help: renderHelp })[view]();
}

function go(v) {
  view = v;
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('active', b.dataset.view === v);
  for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('hidden', sec.id !== `view-${v}`);
  render();
  $('main').scrollTop = 0;
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-view],[data-go],[data-ext],[data-filter],[data-edit-rule],[data-remove-rule],[data-remove-account],[data-relogin],[data-ai-action],[data-ai-check]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.aiAction != null) {
    const [, prompt] = AI_ACTIONS[Number(ds.aiAction)];
    if (prompt.endsWith(': ')) {
      // Konu isteyen komut: metni kutuya koy, kullanıcı tamamlasın
      const input = $('#ai-input');
      input.value = prompt;
      input.focus();
    } else askAi(prompt);
  } else if (ds.aiCheck != null) checkAi();
  else if (ds.relogin) relogin(ds.relogin);
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
