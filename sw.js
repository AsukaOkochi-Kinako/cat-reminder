const CACHE_NAME = 'nyanko-v1';
const ASSETS = ['./index.html', './style.css', './script.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// バックグラウンド通知チェック（Periodic Background Sync）
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-reminders') {
    e.waitUntil(checkAndNotify());
  }
});

// メインスレッドからの通知リクエスト
self.addEventListener('message', e => {
  if (e.data.type === 'SCHEDULE_CHECK') {
    checkAndNotify();
  }
});

async function checkAndNotify() {
  const data = await getStoredData();
  if (!data) return;

  const now = new Date();
  const todayStr = toDateStr(now);
  const timeStr = toTimeStr(now);

  for (const med of data.medications || []) {
    const cat = data.cats.find(c => c.id === med.catId);
    if (!cat) continue;
    if (med.endDate && med.endDate < todayStr) continue;
    if (med.startDate > todayStr) continue;

    for (const t of med.times || []) {
      if (isWithinMinutes(timeStr, t, 5)) {
        await self.registration.showNotification(`💊 ${cat.name}の投薬時間`, {
          body: `${med.name} ${med.dose}`,
          icon: './icon-192.png',
          tag: `med-${med.id}-${todayStr}-${t}`,
          renotify: false
        });
      }
    }
  }

  for (const appt of data.appointments || []) {
    const cat = data.cats.find(c => c.id === appt.catId);
    if (!cat) continue;

    const daysUntil = dateDiffDays(todayStr, appt.date);
    if (daysUntil === 1 && timeStr === '09:00') {
      await self.registration.showNotification(`🏥 明日は${cat.name}の通院日`, {
        body: `${appt.type}（${appt.clinic || 'かかりつけ動物病院'}）`,
        icon: './icon-192.png',
        tag: `appt-reminder-${appt.id}`
      });
    }
    if (daysUntil === 0 && isWithinMinutes(timeStr, appt.time || '09:00', 5)) {
      await self.registration.showNotification(`🏥 ${cat.name}の通院日です`, {
        body: `${appt.type}（${appt.clinic || 'かかりつけ動物病院'}）`,
        icon: './icon-192.png',
        tag: `appt-today-${appt.id}`
      });
    }
  }
}

async function getStoredData() {
  const clients_ = await clients.matchAll();
  if (clients_.length > 0) {
    return new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => resolve(e.data);
      clients_[0].postMessage({ type: 'GET_DATA' }, [ch.port2]);
      setTimeout(() => resolve(null), 1000);
    });
  }
  return null;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function toTimeStr(d) {
  return d.toTimeString().slice(0, 5);
}

function isWithinMinutes(a, b, mins) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return Math.abs((ah * 60 + am) - (bh * 60 + bm)) <= mins;
}

function dateDiffDays(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}
