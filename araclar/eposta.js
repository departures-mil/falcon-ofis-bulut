// Eşitleme hesabının e-posta adresi depoda AÇIK yazılmaz: yayin/eposta.enc.json içinde, hesabın şifresinden
// (FALCON_PASSWORD secret'ı) türetilen anahtarla AES-256-GCM şifreli durur. İş akışları yalnız FALCON_PASSWORD'ü verir.
// Ortamda FALCON_EMAIL varsa o kullanılır (ve dosya yoksa bir kez şifreli olarak yazılır).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FILE = path.join(__dirname, '..', 'yayin', 'eposta.enc.json');
const key = (pass, salt) => crypto.scryptSync(String(pass), salt, 32);

function encrypt(email, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const ct = Buffer.concat([c.update(String(email), 'utf8'), c.final()]);
  return { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function decrypt(o, pass) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(pass, Buffer.from(o.salt, 'base64')), Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
}
// process.env.FALCON_EMAIL'i doldurur; döner: e-posta ya da ''
function ensureEmail() {
  const pass = (process.env.FALCON_PASSWORD || '').trim();
  let email = (process.env.FALCON_EMAIL || '').trim();
  if (email) {
    if (pass && !fs.existsSync(FILE)) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(encrypt(email, pass), null, 1)); console.log('eposta.enc.json yazıldı'); }
    return email;
  }
  if (pass && fs.existsSync(FILE)) {
    try { email = decrypt(JSON.parse(fs.readFileSync(FILE, 'utf8')), pass); } catch { email = ''; }
  }
  if (email) process.env.FALCON_EMAIL = email;
  return email;
}
module.exports = { encrypt, decrypt, ensureEmail, FILE };
