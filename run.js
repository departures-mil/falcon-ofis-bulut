// Falcon Ofis bulut cüzdan izleyici (GitHub Actions, 5 dakikada bir).
// Program bilgisayarda ya da telefonda kapalıyken de kripto cüzdanlara gelen / giden paraları
// kasaya yazar ve Firebase'e gönderir. Programın kendi kodunu (src/) kullanır; aynı işlem iki
// yerde bulunsa bile kayıt numarası işlemden türetildiği için çift kayıt oluşmaz.
// Kayıt defteri (sql.js) şifrelenip Actions önbelleğinde saklanır; her turda yalnız yenilikler çekilir.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('./src/db');
const { createServices } = require('./src/services');
const { checkWallets } = require('./src/wallets');
const { createSync } = require('./src/sync');
const firebaseConfig = require('./src/firebase-config');

const DIR = path.join(__dirname, 'veri');
const DB = path.join(DIR, 'falcon.db');
const ENC = path.join(DIR, 'falcon.db.enc');
const env = (k) => (process.env[k] || '').trim();

function keyBytes() {
  // Ayrı anahtar verilmezse giriş anahtarından türetilir (tek secret yeterli)
  const k = env('FALCON_DB_KEY') || (env('FALCON_REFRESH_TOKEN') && `falcon-veri:${env('FALCON_REFRESH_TOKEN')}`);
  if (!k) throw new Error('FALCON_REFRESH_TOKEN yok');
  return crypto.createHash('sha256').update(k).digest();
}
function decrypt() {
  if (!fs.existsSync(ENC)) return false;
  const buf = fs.readFileSync(ENC);
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  fs.writeFileSync(DB, Buffer.concat([d.update(buf.subarray(28)), d.final()]));
  return true;
}
function encrypt() {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const body = Buffer.concat([c.update(fs.readFileSync(DB)), c.final()]);
  fs.writeFileSync(ENC, Buffer.concat([iv, c.getAuthTag(), body]));
  fs.rmSync(DB, { force: true });
}

// Dosyalar (fotoğraf, dekont) bulutta indirilmez
const files = { exists: async () => false, read: async () => new Uint8Array(), write: async () => {}, remove: async () => {} };
const FILE_COLUMNS = require('./src/sync').FILE_COLUMNS;
function skipFiles(db) {
  db.tx(() => {
    for (const [tbl, col] of Object.entries(FILE_COLUMNS)) {
      if (!db.get("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [tbl])) continue;
      db.db.run(`INSERT OR IGNORE INTO sync_files (rel, state, parts) SELECT DISTINCT "${col}", 'ok', 0 FROM "${tbl}" WHERE "${col}" IS NOT NULL AND "${col}" <> ''`);
    }
  });
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const restored = decrypt();
  const db = await new Database(DB, { backupDir: path.join(DIR, 'yedek') }).open();
  const log = { error: (...a) => console.error(...a.map((x) => String(x).slice(0, 200))) };
  const sync = createSync({ db, fetch: (u, o) => fetch(u, o), files, defaults: firebaseConfig, deviceName: 'Bulut', log, intervalMs: 3600000 });
  const meta = (k) => db.get('SELECT value FROM sync_meta WHERE key = ?', [k])?.value ?? null;
  if (!meta('refresh_token')) {
    const rt = env('FALCON_REFRESH_TOKEN');
    if (!rt) throw new Error('FALCON_REFRESH_TOKEN yok');
    const put = (k, v) => db.db.run('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
    db.tx(() => {
      put('refresh_token', rt);
      put('uid', env('FALCON_UID'));
      put('api_key', env('FALCON_API_KEY') || 'AIzaSyC-inCIkHTOTu_73azseJeXQO1fLYihv_0');
      put('project_id', env('FALCON_PROJECT_ID') || 'falcon-ofis');
      put('device_id', `bulut${crypto.randomBytes(5).toString('hex')}`);
      put('device_name', 'Bulut (GitHub)');
    });
  }
  let r1 = { pulled: 0 };
  let r2 = { pushed: 0 };
  let r = { checked: 0, errors: [], added: [] };
  let failed = null;
  try {
    skipFiles(db);
    r1 = await sync.syncNow();
    skipFiles(db);
    const services = createServices(db, { removeFile: () => {} });
    r = await checkWallets((n, p) => services.call(n, p), (u, o) => fetch(u, o));
    r2 = await sync.syncNow();
  } catch (err) {
    failed = err;
  } finally {
    sync.dispose();
    db.close();
    encrypt();
  }
  if (failed) throw failed;
  // Herkese açık kayıtta para / adres bilgisi yazılmaz, yalnızca sayılar
  console.log(`önbellek: ${restored ? 'var' : 'ilk kurulum'} · çekilen: ${r1.pulled} · kontrol edilen cüzdan: ${r.checked} · hata: ${r.errors.length} · yeni hareket: ${r.added.length} · gönderilen: ${r2.pushed ?? 0}`);
  if (r.errors.length) console.log('hatalı cüzdan türleri:', r.errors.map((e) => `${e.kind}:${e.error}`).join(', '));
}

main().catch((err) => {
  console.error('HATA', err.code || '', String(err.message || err).slice(0, 300));
  process.exit(1);
});
