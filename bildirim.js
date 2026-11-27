// Telegram bildirimi (isteğe bağlı): TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID secret'ları tanımlıysa gönderilir, yoksa sessizce atlanır.
// Bu depo herkese açık olduğundan mesajda tutar ve cüzdan adresi YAZILMAZ: yalnız sayılar, cüzdan türü ve hata kodu.
// Aynı hata her 5 dakikada bir tekrar gönderilmesin diye son gönderilen hata imzası kayıt defterinde (sync_meta) tutulur.
'use strict';

const env = (k) => (process.env[k] || '').trim();
const ayarli = () => !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID'));

function hataMesaji(err) {
  return `⚠️ Falcon Ofis bulut cüzdan izleyici HATA\n${(err && (err.code || '')) || ''} ${String((err && err.message) || err).slice(0, 300)}\n` +
    'Cüzdanlar bu turda kontrol edilemedi. Program bilgisayarda açıksa cüzdanları kendisi kontrol eder.';
}
function cuzdanMesaji(r) {
  const turler = [...new Set(r.errors.map((e) => `${e.kind || e.coin}: ${e.error}`))].join(', ');
  return `⚠️ Falcon Ofis bulut: ${r.errors.length} cüzdan okunamadı (${turler}). Kontrol edilen: ${r.checked}.`;
}
function hareketMesaji(r) {
  const say = {};
  for (const a of r.added) say[`${a.direction === 'out' ? '↗ giden' : '↘ gelen'} ${a.label || a.kind}`] = (say[`${a.direction === 'out' ? '↗ giden' : '↘ gelen'} ${a.label || a.kind}`] || 0) + 1;
  return `💰 Falcon Ofis bulut: ${r.added.length} yeni cüzdan hareketi kasaya yazıldı (${Object.entries(say).map(([k, n]) => `${k} ×${n}`).join(', ')}).`;
}

async function gonder(text, fetchFn = fetch) {
  if (!ayarli()) return false;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text, disable_web_page_preview: true }),
    });
    return !!(res && res.ok);
  } catch {
    return false; // bildirim gönderilemedi diye tur başarısız sayılmaz
  }
}

// Aynı cüzdan hatası art arda turlarda bir kez bildirilir; düzelince imza silinir (sonraki hata yine bildirilir)
function yeniHataMi(db, r) {
  const imza = r.errors.length ? [...new Set(r.errors.map((e) => `${e.kind || e.coin}:${e.error}`))].sort().join('|') : '';
  const eski = db.get("SELECT value FROM sync_meta WHERE key = 'bildirim_hata'")?.value || '';
  if (imza !== eski) db.db.run("INSERT INTO sync_meta (key, value) VALUES ('bildirim_hata', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [imza]);
  return !!imza && imza !== eski;
}

module.exports = { ayarli, gonder, hataMesaji, cuzdanMesaji, hareketMesaji, yeniHataMi };
