// Falcon Ofis güncelleme yayıncısı (GitHub Actions).
// yayin/kuyruk/ klasörüne gönderilen imzalı paketleri (.fopk + .json [+ .apk]) Firebase'deki
// guncellemeler/<platform> belgesine yükler. Programın bilgisayarda açık olması gerekmez.
// Paketler önceden imzalanmış gelir (gizli anahtar GitHub'a hiç girmez); burada yalnızca
// programın açık anahtarıyla doğrulanır. İşlem programdaki electron/yayin.js ile birebir aynıdır.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FirebaseClient } = require('../src/sync');

const ROOT = __dirname;
const QUEUE = path.join(ROOT, 'kuyruk');
const DONE = path.join(ROOT, 'yayinlandi');
const PART_SIZE = 700 * 1024;
const PLATFORMS = ['masaustu', 'telefon'];
const PUBLIC_KEY_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEbrTSFXxCh3+tEsrvxW5N7z2DVUxv7s0ZsdUfeDpeDL/yTJxtvy1Lo+KmsiPpMXuB6hsMQDiMuIERM2so2DKmw==';
const env = (k) => (process.env[k] || '').trim();

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function verify(platform, version, hash, sig) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.from(`${platform}\n${version}\n${hash}`, 'utf8'), key, Buffer.from(String(sig || ''), 'base64'));
  } catch {
    return false;
  }
}
const split = (buf) => {
  const out = [];
  for (let off = 0; off < buf.length; off += PART_SIZE) out.push(buf.subarray(off, off + PART_SIZE));
  return out;
};

async function main() {
  const manifests = fs.existsSync(QUEUE) ? fs.readdirSync(QUEUE).filter((n) => n.endsWith('.json')).sort() : [];
  if (!manifests.length) { console.log('kuyruk boş'); return; }
  if (!env('FALCON_PASSWORD')) throw new Error('FALCON_PASSWORD secret tanımlı değil');
  const c = new FirebaseClient({ apiKey: env('FALCON_API_KEY') || 'AIzaSyC-inCIkHTOTu_73azseJeXQO1fLYihv_0', projectId: env('FALCON_PROJECT_ID') || 'falcon-ofis', fetch: (u, o) => fetch(u, o) });
  await c.signIn(env('FALCON_EMAIL'), env('FALCON_PASSWORD'));
  const url = (name) => `${c.ep.firestore}/${name.split('/').map(encodeURIComponent).join('/')}`;
  const setDoc = async (name, fields) => { await c.ensureToken(); return c.request(url(name), { method: 'PATCH', body: { fields } }); };
  fs.mkdirSync(DONE, { recursive: true });
  let failed = 0;

  for (const n of manifests) {
    const name = path.basename(n, '.json');
    try {
      const m = JSON.parse(fs.readFileSync(path.join(QUEUE, n), 'utf8'));
      if (!PLATFORMS.includes(m.platform) || !/^\d+(\.\d+)*$/.test(String(m.version || ''))) throw new Error('ERR_YAYIN_BAD_MANIFEST');
      const doc = `${c.docsRoot}/guncellemeler/${m.platform}`;
      const gz = fs.readFileSync(path.join(QUEUE, path.basename(m.file || `${name}.fopk`)));
      const hash = sha256(gz);
      if (hash !== m.sha256 || !verify(m.platform, m.version, hash, m.sig)) throw new Error('ERR_YAYIN_SIGNATURE');
      const parts = split(gz);
      console.log(`yayın başlıyor: ${m.platform} ${m.version} (${gz.length} bayt, ${parts.length} parça)`);
      for (let i = 0; i < parts.length; i++) await setDoc(`${doc}/parcalar/${m.version}-${i}`, { b: { bytesValue: parts[i].toString('base64') } });
      const fields = {
        version: { stringValue: m.version }, notes: { stringValue: String(m.notes || '') }, size: { integerValue: String(gz.length) },
        sha256: { stringValue: hash }, sig: { stringValue: m.sig }, parts: { integerValue: String(parts.length) }, publishedAt: { stringValue: new Date().toISOString() },
      };
      if (m.electron) fields.electron = { stringValue: String(m.electron) };
      let keep = null;
      if (m.platform === 'telefon' && m.apk && m.apk.file) {
        const apk = fs.readFileSync(path.join(QUEUE, path.basename(m.apk.file)));
        const v = String(m.apk.version || m.version);
        const ah = sha256(apk);
        if (apk.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('ERR_YAYIN_BAD_APK');
        if (ah !== m.apk.sha256 || !verify('telefon-apk', v, ah, m.apk.sig)) throw new Error('ERR_YAYIN_APK_SIGNATURE');
        const ap = split(apk);
        console.log(`APK yükleniyor: ${v} (${apk.length} bayt, ${ap.length} parça, minShell ${m.apk.minShell})`);
        for (let i = 0; i < ap.length; i++) await setDoc(`${doc}/parcalar/apk-${v}-${i}`, { b: { bytesValue: ap[i].toString('base64') } });
        Object.assign(fields, {
          minShell: { integerValue: String(Number(m.apk.minShell) || 0) }, apkVersion: { stringValue: v }, apkSize: { integerValue: String(apk.length) },
          apkSha256: { stringValue: ah }, apkSig: { stringValue: m.apk.sig }, apkParts: { integerValue: String(ap.length) },
        });
        keep = `apk-${v}-`;
      } else if (m.platform === 'telefon' && m.minShell) {
        fields.minShell = { integerValue: String(Number(m.minShell) || 0) };
      }
      await setDoc(doc, fields);
      // eski sürümlerin parçaları silinir
      let removed = 0;
      try {
        let tok = '';
        const old = [];
        do {
          const r = await c.request(`${url(`${doc}/parcalar`)}?pageSize=300&mask.fieldPaths=yok${tok ? `&pageToken=${encodeURIComponent(tok)}` : ''}`);
          for (const d of r?.documents || []) old.push(d.name);
          tok = r?.nextPageToken || '';
        } while (tok);
        for (const full of old) {
          const id = full.split('/').pop();
          if (id.startsWith(`${m.version}-`) || (keep && id.startsWith(keep))) continue;
          await c.request(url(full), { method: 'DELETE' });
          removed++;
        }
      } catch (err) {
        console.log('eski parçalar silinemedi:', err.code || err.message);
      }
      for (const f of [m.file || `${name}.fopk`, m.apk && m.apk.file, n].filter(Boolean)) fs.rmSync(path.join(QUEUE, path.basename(f)), { force: true });
      fs.writeFileSync(path.join(DONE, `${name}.sonuc.json`), JSON.stringify({ ok: true, platform: m.platform, version: m.version, size: gz.length, parts: parts.length, sha256: hash, apk: m.apk ? m.apk.version : null, publishedAt: fields.publishedAt.stringValue, removedOldParts: removed }, null, 2));
      console.log(`yayınlandı: ${m.platform} ${m.version}`);
    } catch (err) {
      failed++;
      console.error(`yayın hatası ${n}: ${err.code || ''} ${String(err.message || err).slice(0, 300)}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => { console.error('HATA', err.code || '', String(err.message || err).slice(0, 300)); process.exit(1); });
