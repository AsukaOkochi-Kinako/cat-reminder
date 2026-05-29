'use strict';

// ---------- ユーティリティ ----------
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dateDiffDays(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}

function formatDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ---------- Firebase ----------
let db = null;
let roomCode = null;
let roomRef = null;
let unsubscribe = null;

function initFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.database();
    return true;
  } catch (e) {
    console.error('Firebase init failed:', e);
    return false;
  }
}

function isFirebaseConfigured() {
  return typeof FIREBASE_CONFIG !== 'undefined' &&
    FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
}

// ---------- ローカル状態 ----------
let state = {
  cats: [],
  medications: [],
  appointments: [],
  done: {}
};

function applySnapshot(snap) {
  const d = snap.val() || {};
  state.cats        = Object.values(d.cats        || {});
  state.medications = Object.values(d.medications || {});
  state.appointments= Object.values(d.appointments|| {});
  state.done        = d.done || {};
  renderPage();
  scheduleNotifications();
}

// ---------- ルーム管理 ----------
const ROOM_KEY = 'nyanko-room';

function getSavedRoom() {
  return localStorage.getItem(ROOM_KEY);
}

function saveRoomLocally(code) {
  localStorage.setItem(ROOM_KEY, code);
}

async function enterRoom(code) {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  roomCode = code.toUpperCase();
  roomRef = db.ref(`rooms/${roomCode}`);
  saveRoomLocally(roomCode);

  // リアルタイムリスナー
  roomRef.on('value', snap => applySnapshot(snap));
  unsubscribe = () => roomRef.off('value');

  showMainApp();
}

async function createRoom() {
  const code = generateRoomCode();
  await db.ref(`rooms/${code}/meta`).set({ created: Date.now() });
  await enterRoom(code);
}

async function joinRoom(code) {
  const snap = await db.ref(`rooms/${code.toUpperCase()}`).get();
  if (!snap.exists()) throw new Error('ルームが見つかりません');
  await enterRoom(code);
}

function leaveRoom() {
  if (!confirm('このルームを離れますか？\nデータはクラウドに残ります。')) return;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  localStorage.removeItem(ROOM_KEY);
  roomCode = null;
  roomRef = null;
  state = { cats: [], medications: [], appointments: [], done: {} };
  showRoomSetup();
}

// ---------- Firebase 書き込み ----------
function writeItem(path, data) {
  return roomRef.child(path).set(data);
}

function removeItem(path) {
  return roomRef.child(path).remove();
}

function setDone(itemId, isDone) {
  const today = todayStr();
  if (isDone) {
    roomRef.child(`done/${today}/${itemId}`).set(true);
  } else {
    roomRef.child(`done/${today}/${itemId}`).remove();
  }
}

// ---------- Service Worker ----------
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data.type === 'GET_DATA') {
        e.ports[0].postMessage({
          cats: state.cats,
          medications: state.medications,
          appointments: state.appointments
        });
      }
    });
  } catch (e) { console.warn('SW registration failed:', e); }
}

// ---------- 通知 ----------
async function requestNotification() {
  if (!('Notification' in window)) {
    alert('このブラウザは通知に対応していません。\niOSの場合はホーム画面に追加してから開いてください。');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    scheduleNotifications();
    updateNotifBtn();
    new Notification('にゃんこ通知', { body: '通知の設定が完了しました！', icon: './icon-192.png' });
  } else {
    alert('通知が拒否されました。\nブラウザの設定から通知を許可してください。');
  }
}

function updateNotifBtn() {
  const btn = document.getElementById('notif-btn');
  if (!btn) return;
  const granted = 'Notification' in window && Notification.permission === 'granted';
  btn.textContent = granted ? '🔔' : '🔕';
  btn.title = granted ? '通知オン' : '通知をオンにする';
}

const scheduledTimers = [];

function scheduleNotifications() {
  scheduledTimers.forEach(t => clearTimeout(t));
  scheduledTimers.length = 0;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = new Date();
  const today = todayStr();

  state.medications.forEach(med => {
    const cat = state.cats.find(c => c.id === med.catId);
    if (!cat) return;
    if (med.endDate && med.endDate < today) return;
    if (med.startDate > today) return;
    (med.times || []).forEach(t => {
      const [h, m] = t.split(':').map(Number);
      const target = new Date(); target.setHours(h, m, 0, 0);
      const ms = target - now;
      if (ms > 0 && ms < 86400000) {
        scheduledTimers.push(setTimeout(() => {
          new Notification(`💊 ${cat.name}の投薬時間`, {
            body: `${med.name}${med.dose ? ' ' + med.dose : ''}`,
            icon: './icon-192.png',
            tag: `med-${med.id}-${today}-${t}`
          });
        }, ms));
      }
    });
  });

  state.appointments.forEach(appt => {
    const cat = state.cats.find(c => c.id === appt.catId);
    if (!cat) return;
    const days = dateDiffDays(today, appt.date);
    if (days === 1) {
      const target = new Date(); target.setHours(9, 0, 0, 0);
      const ms = target - now;
      if (ms > 0) {
        scheduledTimers.push(setTimeout(() => {
          new Notification(`🏥 明日は${cat.name}の通院日`, {
            body: `${appt.type}（${appt.clinic || 'かかりつけ動物病院'}）`,
            icon: './icon-192.png', tag: `appt-pre-${appt.id}`
          });
        }, ms));
      }
    }
    if (days === 0 && appt.time) {
      const [h, m] = appt.time.split(':').map(Number);
      const target = new Date(); target.setHours(h, m, 0, 0);
      const ms = target - now;
      if (ms > 0) {
        scheduledTimers.push(setTimeout(() => {
          new Notification(`🏥 ${cat.name}の通院日です`, {
            body: `${appt.type}（${appt.clinic || 'かかりつけ動物病院'}）`,
            icon: './icon-192.png', tag: `appt-today-${appt.id}`
          });
        }, ms));
      }
    }
  });
}

// ---------- 画面切り替え ----------
function showRoomSetup() {
  document.getElementById('room-setup').classList.remove('hidden');
  document.getElementById('main-header').classList.add('hidden');
  document.getElementById('main-content').classList.add('hidden');
  document.getElementById('bottom-nav').classList.add('hidden');
}

function showMainApp() {
  document.getElementById('room-setup').classList.add('hidden');
  document.getElementById('main-header').classList.remove('hidden');
  document.getElementById('main-content').classList.remove('hidden');
  document.getElementById('bottom-nav').classList.remove('hidden');
  updateRoomBadge();
  updateNotifBtn();
  renderPage();
}

function updateRoomBadge() {
  const btn = document.getElementById('room-badge-btn');
  if (btn && roomCode) btn.textContent = roomCode;
}

// ---------- ルーティング ----------
let currentPage = 'today';

function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const titles = { today: '今日のスケジュール', cats: '猫の管理', meds: '投薬リスト', appts: '通院スケジュール' };
  document.getElementById('header-title').textContent = titles[page];
  renderPage();
}

function renderPage() {
  const el = document.getElementById('main-content');
  if (!el || el.classList.contains('hidden')) return;
  if (currentPage === 'today') el.innerHTML = renderToday();
  else if (currentPage === 'cats') el.innerHTML = renderCats();
  else if (currentPage === 'meds') el.innerHTML = renderMeds();
  else if (currentPage === 'appts') el.innerHTML = renderAppts();
  bindPageEvents();
}

// ---------- 今日ページ ----------
function renderToday() {
  const today = todayStr();
  const doneToday = state.done[today] || {};
  const items = [];

  state.medications.forEach(med => {
    const cat = state.cats.find(c => c.id === med.catId);
    if (!cat) return;
    if (med.endDate && med.endDate < today) return;
    if (med.startDate > today) return;
    (med.times || []).forEach(t => {
      items.push({ id: `med-${med.id}-${t}`, time: t, label: cat.name, detail: `💊 ${med.name}${med.dose ? ' ' + med.dose : ''}` });
    });
  });

  state.appointments.forEach(appt => {
    const cat = state.cats.find(c => c.id === appt.catId);
    if (!cat || appt.date !== today) return;
    items.push({ id: `appt-${appt.id}`, time: appt.time || '09:00', label: cat.name, detail: `🏥 ${appt.type}` });
  });

  items.sort((a, b) => a.time.localeCompare(b.time));

  const notifBanner = (!('Notification' in window) || Notification.permission !== 'granted')
    ? `<div class="notif-banner">🔕 通知が無効です。<button class="btn btn-primary btn-sm" id="enable-notif-banner">有効にする</button></div>`
    : '';

  if (items.length === 0) {
    return notifBanner + `<div class="empty">🐱<br>今日の予定はありません</div>`;
  }

  const rows = items.map(it => {
    const isDone = !!doneToday[it.id];
    return `<div class="today-item ${isDone ? 'done' : ''}">
      <div class="time-badge">${esc(it.time)}</div>
      <div class="today-info">
        <div class="name">${esc(it.label)}</div>
        <div class="detail">${esc(it.detail)}</div>
      </div>
      <button class="check-btn" data-done-id="${esc(it.id)}" data-is-done="${isDone}">${isDone ? '✓' : ''}</button>
    </div>`;
  }).join('');

  const upcoming = state.appointments
    .map(a => ({ ...a, days: dateDiffDays(today, a.date), cat: state.cats.find(c => c.id === a.catId) }))
    .filter(a => a.days > 0 && a.days <= 7 && a.cat)
    .sort((a, b) => a.days - b.days);

  const upcomingHtml = upcoming.length > 0
    ? `<div class="section-label">近日中の通院</div>` +
      upcoming.map(a =>
        `<div class="card"><div class="card-row">
          <div><div class="card-title">${esc(a.cat.name)} - ${esc(a.type)}</div><div class="card-sub">${esc(formatDate(a.date))}</div></div>
          <span class="upcoming-badge ${a.days <= 2 ? 'urgent' : ''}">あと${esc(String(a.days))}日</span>
        </div></div>`
      ).join('')
    : '';

  return notifBanner + rows + upcomingHtml;
}

// ---------- 猫ページ ----------
function renderCats() {
  if (state.cats.length === 0) {
    return `<div class="empty">🐱<br>猫が登録されていません<br><br><button class="btn btn-primary" id="add-cat-btn" style="max-width:200px;margin:auto">+ 猫を追加</button></div>`;
  }
  const cards = state.cats.map(cat =>
    `<div class="card">
      <div class="cat-card">
        <div class="cat-avatar">🐱</div>
        <div style="flex:1">
          <div class="card-title">${esc(cat.name)}</div>
          <div class="card-sub">${esc([cat.breed, cat.birthDate ? formatDate(cat.birthDate) + '生まれ' : '', cat.weight ? cat.weight + 'kg' : ''].filter(Boolean).join(' · '))}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-danger btn-sm" data-delete-cat="${esc(cat.id)}">削除</button>
      </div>
    </div>`
  ).join('');
  return cards + `<button class="fab" id="add-cat-btn">+</button>`;
}

// ---------- 投薬ページ ----------
function renderMeds() {
  if (state.cats.length === 0) return `<div class="empty">まず猫を登録してください</div>`;
  if (state.medications.length === 0) return `<div class="empty">💊<br>投薬が登録されていません</div><button class="fab" id="add-med-btn">+</button>`;
  const today = todayStr();
  const cards = state.medications.map(med => {
    const cat = state.cats.find(c => c.id === med.catId);
    const active = (!med.endDate || med.endDate >= today) && med.startDate <= today;
    return `<div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">${esc(cat ? cat.name : '?')} - ${esc(med.name)}</div>
          <div class="card-sub">${esc(med.dose ? med.dose + ' · ' : '')}${esc((med.times || []).join('、'))}</div>
          <div class="card-sub">${esc(formatDate(med.startDate))}〜${esc(med.endDate ? formatDate(med.endDate) : '継続中')}</div>
        </div>
        <span class="tag ${active ? 'green' : ''}">${active ? '投薬中' : '終了'}</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-danger btn-sm" data-delete-med="${esc(med.id)}">削除</button>
      </div>
    </div>`;
  }).join('');
  return cards + `<button class="fab" id="add-med-btn">+</button>`;
}

// ---------- 通院ページ ----------
function renderAppts() {
  if (state.cats.length === 0) return `<div class="empty">まず猫を登録してください</div>`;
  const today = todayStr();
  const upcoming = state.appointments.filter(a => a.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past     = state.appointments.filter(a => a.date  < today).sort((a, b) => b.date.localeCompare(a.date));

  const card = a => {
    const cat = state.cats.find(c => c.id === a.catId);
    const days = dateDiffDays(today, a.date);
    return `<div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">${esc(cat ? cat.name : '?')} - ${esc(a.type)}</div>
          <div class="card-sub">${esc(formatDate(a.date))}${a.time ? ' ' + esc(a.time) : ''}${a.clinic ? ' · ' + esc(a.clinic) : ''}</div>
          ${a.notes ? `<div class="card-sub">${esc(a.notes)}</div>` : ''}
        </div>
        ${days >= 0 ? `<span class="upcoming-badge ${days <= 2 ? 'urgent' : ''}">あと${esc(String(days))}日</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn btn-danger btn-sm" data-delete-appt="${esc(a.id)}">削除</button>
      </div>
    </div>`;
  };

  let html = '';
  if (upcoming.length > 0) html += `<div class="section-label">予定</div>` + upcoming.map(card).join('');
  if (past.length > 0)     html += `<div class="section-label">過去の通院</div>` + past.map(card).join('');
  if (!upcoming.length && !past.length) html = `<div class="empty">🏥<br>通院予定がありません</div>`;
  return html + `<button class="fab" id="add-appt-btn">+</button>`;
}

// ---------- モーダル ----------
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function openRoomModal() {
  openModal(`
    <div class="modal-title">ルーム設定</div>
    <div class="room-code-display">
      <div class="room-code-label">招待コード</div>
      <div class="room-code-big">${esc(roomCode)}</div>
      <button class="btn btn-primary btn-sm" id="copy-code-btn">コードをコピー</button>
    </div>
    <p style="font-size:13px;color:var(--muted);margin-top:12px;text-align:center">このコードを家族に共有してください</p>
    <button class="btn btn-danger" id="leave-room-btn" style="margin-top:16px">別のルームに切り替える</button>
  `);
  document.getElementById('copy-code-btn').onclick = () => {
    navigator.clipboard.writeText(roomCode).then(() => alert(`コードをコピーしました：${roomCode}`));
  };
  document.getElementById('leave-room-btn').onclick = () => { closeModal(); leaveRoom(); };
}

// ---------- フォーム ----------
function catForm(onSubmit) {
  openModal(`
    <div class="modal-title">猫を追加</div>
    <div class="form-group"><label>名前 *</label><input id="f-name" type="text" placeholder="例：むぎ" maxlength="50"></div>
    <div class="form-group"><label>品種</label><input id="f-breed" type="text" placeholder="例：アメリカンショートヘア" maxlength="50"></div>
    <div class="form-group"><label>生年月日</label><input id="f-birth" type="date"></div>
    <div class="form-group"><label>体重 (kg)</label><input id="f-weight" type="number" step="0.1" min="0" max="30" placeholder="例：4.2"></div>
    <button class="btn btn-primary" id="f-submit">追加</button>
  `);
  document.getElementById('f-submit').onclick = () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return alert('名前を入力してください');
    onSubmit({ id: uuid(), name, breed: document.getElementById('f-breed').value.trim(), birthDate: document.getElementById('f-birth').value, weight: document.getElementById('f-weight').value });
  };
}

function medForm(cats, onSubmit) {
  const options = cats.map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o.outerHTML; }).join('');
  openModal(`
    <div class="modal-title">投薬を追加</div>
    <div class="form-group"><label>猫 *</label><select id="f-cat">${options}</select></div>
    <div class="form-group"><label>薬の名前 *</label><input id="f-mname" type="text" placeholder="例：プレドニゾロン" maxlength="100"></div>
    <div class="form-group"><label>用量</label><input id="f-dose" type="text" placeholder="例：1錠、0.5ml" maxlength="50"></div>
    <div class="form-group">
      <label>投与時刻 *</label>
      <div class="time-chips" id="time-chips"></div>
      <div class="add-time-row">
        <input type="time" id="f-time-input" value="08:00">
        <button class="btn btn-primary btn-sm" id="add-time-btn">追加</button>
      </div>
    </div>
    <div class="form-group"><label>開始日 *</label><input id="f-start" type="date" value="${esc(todayStr())}"></div>
    <div class="form-group"><label>終了日（継続の場合は空欄）</label><input id="f-end" type="date"></div>
    <button class="btn btn-primary" id="f-submit">追加</button>
  `);
  const times = [];
  const renderChips = () => {
    const container = document.getElementById('time-chips');
    container.innerHTML = '';
    times.forEach((t, i) => {
      const span = document.createElement('span');
      span.className = 'time-chip';
      span.textContent = t;
      const btn = document.createElement('button');
      btn.textContent = '✕';
      btn.onclick = () => { times.splice(i, 1); renderChips(); };
      span.appendChild(btn);
      container.appendChild(span);
    });
  };
  document.getElementById('add-time-btn').onclick = () => {
    const t = document.getElementById('f-time-input').value;
    if (t && !times.includes(t)) { times.push(t); times.sort(); renderChips(); }
  };
  document.getElementById('f-submit').onclick = () => {
    const catId = document.getElementById('f-cat').value;
    const name  = document.getElementById('f-mname').value.trim();
    const start = document.getElementById('f-start').value;
    if (!name || !start || times.length === 0) return alert('名前・開始日・投与時刻を入力してください');
    onSubmit({ id: uuid(), catId, name, dose: document.getElementById('f-dose').value.trim(), times: [...times], startDate: start, endDate: document.getElementById('f-end').value });
  };
}

function apptForm(cats, onSubmit) {
  const options = cats.map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o.outerHTML; }).join('');
  openModal(`
    <div class="modal-title">通院予定を追加</div>
    <div class="form-group"><label>猫 *</label><select id="f-cat">${options}</select></div>
    <div class="form-group"><label>種別 *</label>
      <select id="f-type">
        <option>定期検診</option><option>ワクチン接種</option><option>フィラリア予防</option>
        <option>ノミ・ダニ予防</option><option>歯科検診</option><option>再診</option><option>その他</option>
      </select>
    </div>
    <div class="form-group"><label>日付 *</label><input id="f-date" type="date" value="${esc(todayStr())}"></div>
    <div class="form-group"><label>時刻</label><input id="f-time" type="time"></div>
    <div class="form-group"><label>動物病院名</label><input id="f-clinic" type="text" placeholder="例：○○動物病院" maxlength="100"></div>
    <div class="form-group"><label>メモ</label><textarea id="f-notes" placeholder="持ち物・注意事項など" maxlength="300"></textarea></div>
    <button class="btn btn-primary" id="f-submit">追加</button>
  `);
  document.getElementById('f-submit').onclick = () => {
    const catId = document.getElementById('f-cat').value;
    const type  = document.getElementById('f-type').value;
    const date  = document.getElementById('f-date').value;
    if (!date) return alert('日付を入力してください');
    onSubmit({ id: uuid(), catId, type, date, time: document.getElementById('f-time').value, clinic: document.getElementById('f-clinic').value.trim(), notes: document.getElementById('f-notes').value.trim() });
  };
}

// ---------- イベント ----------
function bindPageEvents() {
  const el = id => document.getElementById(id);

  el('add-cat-btn')?.addEventListener('click', () => {
    catForm(cat => { writeItem(`cats/${cat.id}`, cat); closeModal(); });
  });
  el('add-med-btn')?.addEventListener('click', () => {
    medForm(state.cats, med => { writeItem(`medications/${med.id}`, med); closeModal(); });
  });
  el('add-appt-btn')?.addEventListener('click', () => {
    apptForm(state.cats, appt => { writeItem(`appointments/${appt.id}`, appt); closeModal(); });
  });
  el('enable-notif-banner')?.addEventListener('click', requestNotification);

  document.querySelectorAll('[data-delete-cat]').forEach(b => {
    b.onclick = () => {
      if (!confirm('削除しますか？')) return;
      const id = b.dataset.deleteCat;
      removeItem(`cats/${id}`);
      state.medications.filter(m => m.catId === id).forEach(m => removeItem(`medications/${m.id}`));
      state.appointments.filter(a => a.catId === id).forEach(a => removeItem(`appointments/${a.id}`));
    };
  });
  document.querySelectorAll('[data-delete-med]').forEach(b => {
    b.onclick = () => { if (!confirm('削除しますか？')) return; removeItem(`medications/${b.dataset.deleteMed}`); };
  });
  document.querySelectorAll('[data-delete-appt]').forEach(b => {
    b.onclick = () => { if (!confirm('削除しますか？')) return; removeItem(`appointments/${b.dataset.deleteAppt}`); };
  });
  document.querySelectorAll('[data-done-id]').forEach(b => {
    b.onclick = () => {
      const isDone = b.dataset.isDone === 'true';
      setDone(b.dataset.doneId, !isDone);
    };
  });
}

// ---------- 起動 ----------
document.addEventListener('DOMContentLoaded', async () => {
  registerSW();

  if (!isFirebaseConfigured()) {
    document.getElementById('room-setup').innerHTML =
      `<div class="room-setup-box"><div class="room-logo">⚠️</div><h1>設定が必要です</h1><p class="room-desc">index.html の FIREBASE_CONFIG を<br>あなたのFirebase設定に書き換えてください</p></div>`;
    return;
  }

  if (!initFirebase()) {
    alert('Firebase の初期化に失敗しました。設定を確認してください。');
    return;
  }

  // ルームコードセットアップ
  document.getElementById('create-room-btn').onclick = async () => {
    try { await createRoom(); }
    catch (e) { showSetupError('ルームの作成に失敗しました'); }
  };

  document.getElementById('join-room-btn').onclick = async () => {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (code.length !== 6) return showSetupError('6文字のコードを入力してください');
    try { await joinRoom(code); }
    catch (e) { showSetupError(e.message || '参加に失敗しました'); }
  };

  document.getElementById('join-code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // 通知ボタン
  document.getElementById('notif-btn').onclick = requestNotification;

  // ルームバッジ
  document.getElementById('room-badge-btn').onclick = openRoomModal;

  // ナビ
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.onclick = () => navigate(b.dataset.page);
  });

  // モーダル閉じる
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  };

  // 保存済みルームに自動接続
  const saved = getSavedRoom();
  if (saved) {
    try { await enterRoom(saved); }
    catch { showRoomSetup(); }
  } else {
    showRoomSetup();
  }
});

function showSetupError(msg) {
  const el = document.getElementById('setup-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
