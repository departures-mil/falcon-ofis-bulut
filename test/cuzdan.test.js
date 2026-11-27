// Para hareketi testleri: bulut izleyicinin cüzdan hareketlerini kasaya doğru, bir kez ve doğru yönde yazdığı denetlenir.
// Ağ kullanılmaz: blok gezgini (mempool.space biçimi) sahte fetch ile taklit edilir. Çalıştır: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { checkWallets, walletTxRowId } = require('../src/wallets');

const ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const OTHER = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const BTC_ACCOUNT = 105;

async function yeniDefter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fob-'));
  const db = await new Database(path.join(dir, 'falcon.db')).open();
  const services = createServices(db, { removeFile: () => {} });
  return { db, services, call: (n, p) => services.call(n, p), dir };
}
function bakiye(db, account) {
  return db.get(`SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) AS b FROM cash_transactions WHERE account_id = ?`, [account]).b;
}
// mempool.space biçiminde işlem listesi döndüren sahte fetch
function sahteGezgin(txs, sayac = { n: 0 }) {
  return async (url) => {
    sayac.n++;
    if (/\/address\/[^/]+\/txs$/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(txs) };
    return { ok: false, status: 404, text: async () => '' };
  };
}
const gelen = (txid, sats, time, confirmed = true) => ({ txid, fee: 200, status: { confirmed, block_time: time }, vin: [{ prevout: { scriptpubkey_address: OTHER, value: sats + 500 } }], vout: [{ scriptpubkey_address: ADDR, value: sats }] });
const giden = (txid, spent, toOther, change, fee, time) => ({ txid, fee, status: { confirmed: true, block_time: time }, vin: [{ prevout: { scriptpubkey_address: ADDR, value: spent } }], vout: [{ scriptpubkey_address: OTHER, value: toOther }, ...(change ? [{ scriptpubkey_address: ADDR, value: change }] : [])] });

test('gelen ve giden BTC kasaya doğru yazılır: gelen = giriş, giden = çıkış (ağ ücreti dahil), para üstü düşülür', async () => {
  const { db, call } = await yeniDefter();
  call('saveWallet', { coin: 'BTC', address: ADDR, label: 'Test' });
  const t = Math.floor(Date.now() / 1000) + 60;
  const txs = [
    gelen('a'.repeat(64), 150000, t),                       // +0,0015 BTC
    giden('b'.repeat(64), 100000, 60000, 30000, 10000, t + 1), // harcanan 0,001; para üstü 0,0003 → çıkış 0,0006 + ücret 0,0001 = 0,0007
  ];
  const r = await checkWallets(call, sahteGezgin(txs));
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.added.length, 2);
  const rows = db.all('SELECT direction, amount, category FROM cash_transactions WHERE account_id = ? ORDER BY direction', [BTC_ACCOUNT]);
  assert.deepStrictEqual(rows.map((x) => [x.direction, x.amount, x.category]), [['in', 0.0015, 'crypto_in'], ['out', 0.0007, 'crypto_out']]);
  assert.ok(Math.abs(bakiye(db, BTC_ACCOUNT) - 0.0008) < 1e-12, 'bakiye 0,0015 − 0,0007');
  db.close();
});

test('aynı hareket ikinci turda tekrar yazılmaz (her 5 dakikada bir çalışsa da çift kayıt yok)', async () => {
  const { db, call } = await yeniDefter();
  call('saveWallet', { coin: 'BTC', address: ADDR });
  const t = Math.floor(Date.now() / 1000) + 60;
  const fetchFn = sahteGezgin([gelen('c'.repeat(64), 50000, t)]);
  await checkWallets(call, fetchFn);
  const r2 = await checkWallets(call, fetchFn);
  const r3 = await checkWallets(call, fetchFn);
  assert.strictEqual(r2.added.length + r3.added.length, 0);
  assert.strictEqual(r2.errors.length + r3.errors.length, 0, 'tekrar turunda hata da yok');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM cash_transactions WHERE account_id = ?', [BTC_ACCOUNT]).n, 1);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM crypto_wallet_tx').n, 1);
  db.close();
});

test('izlemeye alınmadan önceki ve onaylanmamış işlemler yazılmaz', async () => {
  const { db, call } = await yeniDefter();
  call('saveWallet', { coin: 'BTC', address: ADDR });
  const t = Math.floor(Date.now() / 1000);
  const r = await checkWallets(call, sahteGezgin([
    gelen('d'.repeat(64), 70000, t - 86400),      // izleme başlamadan önce
    gelen('e'.repeat(64), 80000, t + 60, false),   // henüz onaylanmamış: sonraki turda
  ]));
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(bakiye(db, BTC_ACCOUNT), 0);
  db.close();
});

test('telefon / bilgisayar aynı hareketi önce eklediyse (eşitlemeyle geldi) kasaya ikinci kez yazılmaz', async () => {
  const { db, call } = await yeniDefter();
  call('saveWallet', { coin: 'BTC', address: ADDR });
  const t = Math.floor(Date.now() / 1000) + 60;
  const txid = 'f'.repeat(64);
  const id = walletTxRowId(`BTC:${txid}:${ADDR}`, t);
  db.run("INSERT INTO cash_transactions (id, account_id, direction, amount, date, category, description) VALUES (?, ?, 'in', 0.0009, '2026-11-27', 'crypto_in', 'öbür cihazdan')", [id, BTC_ACCOUNT]);
  const r = await checkWallets(call, sahteGezgin([gelen(txid, 90000, t)]));
  assert.strictEqual(r.added.length, 1, 'cüzdan kaydı tutulur');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM cash_transactions WHERE account_id = ?', [BTC_ACCOUNT]).n, 1, 'kasada tek kayıt');
  assert.ok(Math.abs(bakiye(db, BTC_ACCOUNT) - 0.0009) < 1e-12);
  db.close();
});

test('gezginlere ulaşılamazsa kasaya hiçbir şey yazılmaz, hata kaydedilir ve tur çökmez', async () => {
  const { db, call } = await yeniDefter();
  call('saveWallet', { coin: 'BTC', address: ADDR });
  const r = await checkWallets(call, async () => { throw new Error('ağ yok'); });
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].error, 'ERR_WALLET_OFFLINE');
  assert.strictEqual(bakiye(db, BTC_ACCOUNT), 0);
  assert.match(db.get('SELECT last_error FROM local_wallet_state').last_error, /^ERR_WALLET_OFFLINE/);
  db.close();
});

test('kayıt defteri şifresi: doğru şifreyle açılır, yanlış şifreyle açılmaz (veri bozulmaz)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fob-enc-'));
  process.env.FALCON_VERI_DIR = dir;
  process.env.FALCON_EMAIL = 'test@ornek';
  process.env.FALCON_PASSWORD = 'dogru-sifre';
  delete require.cache[require.resolve('../run.js')];
  const run = require('../run.js');
  fs.writeFileSync(run.DB, Buffer.from('SQLite format 3\0 deneme verisi'));
  run.encrypt();
  assert.ok(!fs.existsSync(run.DB) && fs.existsSync(run.ENC), 'açık dosya silinir, şifreli kalır');
  assert.ok(!fs.readFileSync(run.ENC).includes(Buffer.from('deneme verisi')), 'şifreli dosyada açık metin yok');
  process.env.FALCON_PASSWORD = 'yanlis-sifre';
  assert.throws(() => run.decrypt(), 'yanlış şifre');
  process.env.FALCON_PASSWORD = 'dogru-sifre';
  assert.strictEqual(run.decrypt(), true);
  assert.strictEqual(fs.readFileSync(run.DB, 'utf8'), 'SQLite format 3\0 deneme verisi');
});

test('Telegram bildirimi: secret yoksa gönderilmez; mesajda tutar ve adres yok; aynı hata bir kez bildirilir', async () => {
  const b = require('../bildirim');
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  let n = 0;
  assert.strictEqual(await b.gonder('x', async () => { n++; return { ok: true }; }), false);
  assert.strictEqual(n, 0);
  process.env.TELEGRAM_BOT_TOKEN = '123:abc'; process.env.TELEGRAM_CHAT_ID = '42';
  let giden = null;
  assert.strictEqual(await b.gonder('merhaba', async (url, o) => { giden = { url, body: JSON.parse(o.body) }; return { ok: true }; }), true);
  assert.match(giden.url, /^https:\/\/api\.telegram\.org\/bot123:abc\/sendMessage$/);
  assert.deepStrictEqual([giden.body.chat_id, giden.body.text], ['42', 'merhaba']);
  assert.strictEqual(await b.gonder('x', async () => { throw new Error('ağ'); }), false, 'gönderilemezse tur bozulmaz');
  const r = { checked: 2, errors: [{ kind: 'BTC', coin: 'BTC', address: ADDR, error: 'ERR_WALLET_OFFLINE' }], added: [{ direction: 'in', label: 'BTC (Bitcoin)', amount: 0.5, address: ADDR }] };
  for (const m of [b.cuzdanMesaji(r), b.hareketMesaji(r)]) {
    assert.ok(!m.includes(ADDR) && !m.includes('0.5') && !m.includes('0,5'), 'adres / tutar yazılmaz: ' + m);
  }
  const { db } = await yeniDefter();
  assert.strictEqual(b.yeniHataMi(db, r), true, 'ilk hata bildirilir');
  assert.strictEqual(b.yeniHataMi(db, r), false, 'aynı hata tekrar bildirilmez');
  assert.strictEqual(b.yeniHataMi(db, { ...r, errors: [] }), false, 'düzelince bildirim yok');
  assert.strictEqual(b.yeniHataMi(db, r), true, 'yeniden bozulursa yine bildirilir');
  db.close();
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
});
