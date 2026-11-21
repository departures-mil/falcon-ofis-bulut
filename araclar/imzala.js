// Claude çalışma alanında çalışır: paketleri programın gizli anahtarıyla imzalar ve yayin/kuyruk/'a koyar.
// Gizli anahtar depoya YAZILMAZ. Kullanım:
//   node araclar/imzala.js <ozel-anahtar.pem> <manifest.json> <dosyaların klasörü>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [pemFile, manFile, srcDir] = process.argv.slice(2);
const pem = fs.readFileSync(pemFile, 'utf8');
const m = JSON.parse(fs.readFileSync(manFile, 'utf8'));
const Q = path.join(__dirname, '..', 'yayin', 'kuyruk');
fs.mkdirSync(Q, { recursive: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sign = (p, v, h) => crypto.sign('sha256', Buffer.from(`${p}\n${v}\n${h}`, 'utf8'), pem).toString('base64');
const name = `${m.platform}-${m.version}`;
m.file = m.file || `${name}.fopk`;
const gz = fs.readFileSync(path.join(srcDir, m.file));
const zlib = require('zlib');
const raw = zlib.gunzipSync(gz);
const hl = raw.readUInt32BE(6);
const hv = JSON.parse(raw.subarray(10, 10 + hl).toString('utf8')).version;
if (hv !== m.version) throw new Error(`paket sürümü ${hv} ≠ ${m.version}`);
m.sha256 = sha(gz); m.sig = sign(m.platform, m.version, m.sha256);
fs.copyFileSync(path.join(srcDir, m.file), path.join(Q, m.file));
if (m.apk && m.apk.file) {
  const apk = fs.readFileSync(path.join(srcDir, m.apk.file));
  m.apk.version = String(m.apk.version || m.version);
  m.apk.sha256 = sha(apk); m.apk.sig = sign('telefon-apk', m.apk.version, m.apk.sha256);
  fs.copyFileSync(path.join(srcDir, m.apk.file), path.join(Q, m.apk.file));
}
fs.writeFileSync(path.join(Q, `${name}.json`), JSON.stringify(m, null, 2));
console.log('imzalandı:', name, m.apk ? `+ APK ${m.apk.version}` : '');
