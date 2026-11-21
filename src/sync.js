// Bulut eşitlemesi (Google Firebase: giriş için Authentication, veriler için Firestore).
// Masaüstü ve telefon aynı kodu kullanır. Her kayıt satırı bulutta bir belge olarak tutulur:
//   users/{kullanıcı}/rows/{tablo~anahtar}  { t, k, d (satırın JSON hali), del, dev, at (sunucu saati) }
// Dosyalar (ürün fotoğrafı, dekont) parçalara bölünerek users/{kullanıcı}/files altında saklanır.
//
// Çalışma şekli: her yerel değişiklik tetikleyicilerle sync_outbox tablosuna yazılır. Eşitleme turunda
// önce buluttaki yenilikler alınır, sonra bekleyen değişiklikler gönderilir. Bir kayıt iki cihazda
// birden değiştiyse sütun sütun birleştirilir; stok adetleri gibi sayaçlar toplanarak birleştirilir.

// v1.15: local_ ile başlayan tablolar da cihaza özeldir (buluta gönderilmez)
const LOCAL_TABLE_RE = /^(sqlite_|sync_|local_|schema_migrations$)/;
// Cihaza özel ayarlar buluta gönderilmez
const LOCAL_SETTINGS = ['language'];
// Aynı anda iki cihazda değişirse farkları toplanan sütunlar
const COUNTERS = { product_stock: ['quantity'], materials: ['quantity'] };
// Dosya yolu tutan sütunlar
const FILE_COLUMNS = { electricity_meters: 'photo_path', electricity_readings: 'photo_path', internet_services: 'qr_path', recurring_plans: 'qr_path', recurring_files: 'file_path', receipts: 'file_path', product_images: 'file_path', materials: 'image_path', fixed_assets: 'image_path', asset_images: 'file_path', trade_files: 'file_path', item_codes: 'image_path', cash_transactions: 'sc_qr_path', shamcash_payees: 'qr_path' };
// v1.14: seri numaraları (aynı numara iki cihazda farklı kayda verilirse yereldeki kayda sıradaki numara verilir)
const SERIAL_PREFIX = { products: 'U', materials: 'M', fixed_assets: 'D' };
// Cihazda "gerçek" kayıt var mı (sadece başlangıç verileri değil) anlamak için bakılan tablolar
const USER_TABLES = ['cash_transactions', 'people', 'products', 'materials', 'fixed_assets', 'debts', 'gifts', 'sales', 'purchases'];
const TRIGGER_VERSION = 1;
const PAGE = 300;
const PUSH_BATCH = 200;
const CHUNK = 700 * 1024;
const FILES_PER_ROUND = 15;

const DEFAULT_ENDPOINTS = {
  auth: 'https://identitytoolkit.googleapis.com/v1',
  token: 'https://securetoken.googleapis.com/v1',
  firestore: 'https://firestore.googleapis.com/v1',
};

class SyncError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function b64encode(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decode(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const qs = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------- Firebase REST istemcisi ----------

class FirebaseClient {
  constructor({ apiKey, projectId, fetch, endpoints = {} }) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.fetchFn = fetch;
    this.ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.idToken = null;
    this.expiresAt = 0;
    this.uid = null;
    this.refreshToken = null;
  }

  get docsRoot() {
    return `projects/${this.projectId}/databases/(default)/documents`;
  }

  get userRoot() {
    return `${this.docsRoot}/users/${this.uid}`;
  }

  async request(url, { method = 'GET', body, form, auth = true, timeout = 30000 } = {}) {
    const headers = {};
    if (auth && this.idToken) headers.Authorization = `Bearer ${this.idToken}`;
    let payload;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    let res;
    try {
      res = await this.fetchFn(url, { method, headers, body: payload, signal: controller?.signal });
    } catch (err) {
      throw new SyncError('ERR_SYNC_OFFLINE', String(err?.message || err));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    const text = await res.text().catch(() => '');
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new SyncError(this.mapError(res.status, data), data?.error?.message || data?.error_description || String(text).slice(0, 300));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  mapError(status, data) {
    const msg = String(data?.error?.message || data?.error?.status || data?.error || '');
    if (/EMAIL_EXISTS/.test(msg)) return 'ERR_SYNC_EMAIL_EXISTS';
    if (/WEAK_PASSWORD/.test(msg)) return 'ERR_SYNC_WEAK_PASSWORD';
    if (/INVALID_EMAIL|MISSING_EMAIL/.test(msg)) return 'ERR_SYNC_INVALID_EMAIL';
    if (/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD|MISSING_PASSWORD/.test(msg)) return 'ERR_SYNC_BAD_LOGIN';
    if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/.test(msg)) return 'ERR_SYNC_AUTH_DISABLED';
    if (/API.?KEY|API_KEY_INVALID|CONFIGURATION_NOT_FOUND|PROJECT_NOT_FOUND/i.test(msg)) return 'ERR_SYNC_BAD_CONFIG';
    if (/TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_REFRESH_TOKEN|INVALID_ID_TOKEN/.test(msg)) return 'ERR_SYNC_AUTH';
    if (status === 401) return 'ERR_SYNC_AUTH';
    if (status === 403) return 'ERR_SYNC_PERMISSION';
    if (status === 404 && /database|project/i.test(msg)) return 'ERR_SYNC_NO_DATABASE';
    if (status === 409 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/.test(msg)) return 'ERR_SYNC_CONFLICT';
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(msg)) return 'ERR_SYNC_QUOTA';
    return 'ERR_SYNC_SERVER';
  }

  setSession({ idToken, refreshToken, uid, expiresIn }) {
    this.idToken = idToken;
    this.refreshToken = refreshToken;
    this.uid = uid;
    this.expiresAt = Date.now() + (Number(expiresIn) || 3600) * 1000;
  }

  async signIn(email, password, create = false) {
    const op = create ? 'accounts:signUp' : 'accounts:signInWithPassword';
    const r = await this.request(`${this.ep.auth}/${op}?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST', auth: false, body: { email, password, returnSecureToken: true },
    });
    this.setSession({ idToken: r.idToken, refreshToken: r.refreshToken, uid: r.localId, expiresIn: r.expiresIn });
    return { uid: r.localId, email: r.email || email };
  }

  async ensureToken() {
    if (this.idToken && Date.now() < this.expiresAt - 120000) return;
    if (!this.refreshToken) throw new SyncError('ERR_SYNC_AUTH');
    const r = await this.request(`${this.ep.token}/token?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST', auth: false, form: { grant_type: 'refresh_token', refresh_token: this.refreshToken },
    });
    this.setSession({ idToken: r.id_token, refreshToken: r.refresh_token, uid: r.user_id, expiresIn: r.expires_in });
  }

  async commit(writes) {
    return this.request(`${this.ep.firestore}/${this.docsRoot}:commit`, { method: 'POST', body: { writes } });
  }

  async runQuery(collectionId, { where, after, limit = PAGE, ordered = true } = {}) {
    const structuredQuery = { from: [{ collectionId }], limit };
    if (ordered) {
      structuredQuery.orderBy = [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }];
    }
    if (where) structuredQuery.where = where;
    if (after) {
      structuredQuery.startAt = { values: [{ timestampValue: after.at }, { referenceValue: after.name }], before: false };
    }
    const r = await this.request(`${this.ep.firestore}/${this.userRoot}:runQuery`, { method: 'POST', body: { structuredQuery } });
    return (Array.isArray(r) ? r : []).filter((x) => x.document).map((x) => x.document);
  }

  async getDoc(name) {
    try {
      return await this.request(`${this.ep.firestore}/${name.split('/').map(encodeURIComponent).join('/')}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }
}

// ---------- Eşitleme motoru ----------

function createSync({
  db, fetch, files, defaults = {}, endpoints = {}, deviceName = '', onChange = () => {}, onStatus = () => {},
  beforeReplace = null, intervalMs = 20000, log = console,
}) {
  let client = null;
  let timer = null;
  let pokeTimer = null;
  let running = null;
  let again = false;
  let stopped = true;
  const state = { phase: 'idle', error: null, errorDetail: null, lastSync: null, lastChange: null };

  // --- yardımcılar ---
  const meta = (key) => db.get('SELECT value FROM sync_meta WHERE key = ?', [key])?.value ?? null;
  const setMetaRaw = (key, value) => {
    if (value === null || value === undefined) db.db.run('DELETE FROM sync_meta WHERE key = ?', [key]);
    else db.db.run('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
  };
  const setMeta = (obj) => db.tx(() => {
    for (const [k, v] of Object.entries(obj)) setMetaRaw(k, v);
  });

  let tableCache = null;
  function tables() {
    if (!tableCache) {
      tableCache = new Map();
      for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
        if (LOCAL_TABLE_RE.test(name)) continue;
        const cols = db.all(`PRAGMA table_info(${qi(name)})`);
        const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
        if (!pk.length) continue;
        const uniques = [];
        for (const idx of db.all(`PRAGMA index_list(${qi(name)})`)) {
          if (!idx.unique || idx.origin === 'pk') continue;
          const ic = db.all(`PRAGMA index_info(${qi(idx.name)})`).map((x) => x.name);
          if (ic.length === 1) uniques.push(ic[0]);
        }
        tableCache.set(name, {
          name,
          cols: cols.map((c) => c.name),
          pk: pk.map((c) => ({ name: c.name, int: /INT/i.test(c.type) })),
          uniques,
        });
      }
    }
    return tableCache;
  }

  const pkExpr = (t, alias) => t.pk.map((c) => `CAST(${alias}.${qi(c.name)} AS TEXT)`).join(" || '|' || ");
  function pkWhere(t, pk) {
    const parts = t.pk.length === 1 ? [pk] : String(pk).split('|');
    return {
      sql: t.pk.map((c) => `${qi(c.name)} = ?`).join(' AND '),
      params: t.pk.map((c, i) => (c.int ? Number(parts[i]) : parts[i])),
    };
  }
  const pkOf = (t, row) => t.pk.map((c) => String(row[c.name])).join('|');
  const isLocalSetting = (tbl, pk) => tbl === 'settings' && LOCAL_SETTINGS.includes(pk);

  function readRow(tbl, pk) {
    const t = tables().get(tbl);
    const w = pkWhere(t, pk);
    return db.get(`SELECT * FROM ${qi(tbl)} WHERE ${w.sql}`, w.params);
  }

  // Yerel değişiklikleri sync_outbox'a yazan tetikleyiciler (her açılışta eksikse kurulur)
  function installTriggers() {
    const existing = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name));
    const sql = [];
    for (const t of tables().values()) {
      const local = (alias) => (t.name === 'settings' ? ` AND ${alias}.key NOT IN (${LOCAL_SETTINGS.map(qs).join(',')})` : '');
      const body = (alias) => `INSERT INTO sync_outbox (tbl, pk) VALUES (${qs(t.name)}, ${pkExpr(t, alias)}) ON CONFLICT(tbl, pk) DO UPDATE SET n = n + 1;`;
      const defs = [
        ['i', 'AFTER INSERT', 'NEW'],
        ['u', 'AFTER UPDATE', 'NEW'],
        ['d', 'AFTER DELETE', 'OLD'],
      ];
      for (const [suffix, when, alias] of defs) {
        const name = `sync${TRIGGER_VERSION}_${t.name}_${suffix}`;
        if (existing.has(name)) continue;
        sql.push(`CREATE TRIGGER ${qi(name)} ${when} ON ${qi(t.name)} WHEN (SELECT applying FROM sync_flag) = 0${local(alias)} BEGIN ${body(alias)} END;`);
      }
    }
    if (sql.length) db.db.exec(sql.join('\n'));
  }

  const docId = (tbl, pk) => `${tbl}~${encodeURIComponent(pk)}`;
  const fileDocId = (rel) => String(rel).replace(/\//g, '~');

  function setBase(tbl, pk, at, data) {
    db.db.run('INSERT INTO sync_base (tbl, pk, at, data) VALUES (?,?,?,?) ON CONFLICT(tbl, pk) DO UPDATE SET at = excluded.at, data = excluded.data', [tbl, pk, at, data]);
  }
  const getBase = (tbl, pk) => db.get('SELECT at, data FROM sync_base WHERE tbl = ? AND pk = ?', [tbl, pk]);
  const outboxHas = (tbl, pk) => !!db.get('SELECT 1 AS x FROM sync_outbox WHERE tbl = ? AND pk = ?', [tbl, pk]);
  const enqueue = (tbl, pk) => db.db.run('INSERT INTO sync_outbox (tbl, pk) VALUES (?, ?) ON CONFLICT(tbl, pk) DO UPDATE SET n = n + 1', [tbl, pk]);

  // Uzak değişiklikler uygulanırken tetikleyiciler susturulur ve yabancı anahtar sırası beklenmez
  function applying(fn) {
    db.db.run('PRAGMA foreign_keys = OFF');
    try {
      return db.tx(() => {
        db.db.run('UPDATE sync_flag SET applying = 1');
        try {
          return fn();
        } finally {
          db.db.run('UPDATE sync_flag SET applying = 0');
        }
      });
    } finally {
      db.db.run('PRAGMA foreign_keys = ON');
    }
  }

  function writeLocal(tbl, pk, row, depth = 0) {
    const t = tables().get(tbl);
    const w = pkWhere(t, pk);
    if (!row) {
      const old = FILE_COLUMNS[tbl] ? db.get(`SELECT * FROM ${qi(tbl)} WHERE ${w.sql}`, w.params) : null;
      db.db.run(`DELETE FROM ${qi(tbl)} WHERE ${w.sql}`, w.params);
      if (old?.[FILE_COLUMNS[tbl]]) removedFiles.add(old[FILE_COLUMNS[tbl]]);
      return;
    }
    const cols = t.cols.filter((c) => Object.prototype.hasOwnProperty.call(row, c));
    const pkNames = t.pk.map((c) => c.name);
    const setCols = cols.filter((c) => !pkNames.includes(c));
    const sql = `INSERT INTO ${qi(tbl)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      + ` ON CONFLICT(${pkNames.map(qi).join(', ')}) DO ${setCols.length ? `UPDATE SET ${setCols.map((c) => `${qi(c)} = excluded.${qi(c)}`).join(', ')}` : 'NOTHING'}`;
    try {
      db.db.run(sql, cols.map((c) => row[c]));
    } catch (err) {
      // Aynı ad / kod iki cihazda farklı kayıtlara verilmişse yereldeki kayda "(2)" eklenir
      const m = /UNIQUE constraint failed: \w+\.(\w+)/.exec(err.message);
      if (!m || depth > 2 || !t.uniques.includes(m[1])) throw err;
      const col = m[1];
      const other = db.get(`SELECT * FROM ${qi(tbl)} WHERE ${qi(col)} = ?`, [row[col]]);
      if (!other) throw err;
      let value;
      if (col === 'serial' && SERIAL_PREFIX[tbl]) {
        const p = SERIAL_PREFIX[tbl];
        const max = Math.max(
          db.get(`SELECT MAX(CAST(substr(serial, 3) AS INTEGER)) AS n FROM ${qi(tbl)} WHERE serial GLOB '${p}-[0-9]*'`)?.n || 0,
          /^[A-Z]-\d+$/.test(String(row[col])) ? Number(String(row[col]).slice(2)) : 0,
        );
        value = `${p}-${String(max + 1).padStart(5, '0')}`;
      } else {
        let n = 2;
        do {
          value = `${row[col]} (${n++})`;
        } while (db.get(`SELECT 1 AS x FROM ${qi(tbl)} WHERE ${qi(col)} = ?`, [value]));
      }
      const ow = pkWhere(t, pkOf(t, other));
      db.db.run(`UPDATE ${qi(tbl)} SET ${qi(col)} = ? WHERE ${ow.sql}`, [value, ...ow.params]);
      enqueue(tbl, pkOf(t, other));
      writeLocal(tbl, pk, row, depth + 1);
    }
  }

  function merge(tbl, base, local, remote) {
    const out = { ...remote };
    const counters = COUNTERS[tbl] || [];
    for (const c of Object.keys(local)) {
      if (counters.includes(c)) {
        const b = base ? Number(base[c]) || 0 : 0;
        out[c] = Math.round(((Number(remote[c]) || 0) + (Number(local[c]) || 0) - b) * 1e9) / 1e9;
      } else if (!base || local[c] !== base[c]) {
        out[c] = local[c];
      }
    }
    return out;
  }

  const removedFiles = new Set();

  // Buluttan gelen bir belgeyi yerel veritabanına işler; değişiklik olduysa true
  function applyDoc(doc, { force = false } = {}) {
    const f = doc.fields || {};
    const tbl = f.t?.stringValue;
    const pk = f.k?.stringValue;
    const at = doc.updateTime;
    if (!tbl || pk === undefined) return false;
    const t = tables().get(tbl);
    if (!t || isLocalSetting(tbl, pk)) return false;
    const base = force ? null : getBase(tbl, pk);
    if (base && base.at === at) return false;
    const del = !!f.del?.booleanValue;
    const d = del ? null : (f.d?.stringValue ?? null);
    const remote = d ? JSON.parse(d) : null;
    if (force || !outboxHas(tbl, pk)) {
      writeLocal(tbl, pk, remote);
      setBase(tbl, pk, at, d);
      return true;
    }
    const local = readRow(tbl, pk);
    if (!remote) {
      // Diğer cihazda silinmiş: silme geçerli olur
      writeLocal(tbl, pk, null);
      db.db.run('DELETE FROM sync_outbox WHERE tbl = ? AND pk = ?', [tbl, pk]);
    } else if (local) {
      writeLocal(tbl, pk, merge(tbl, base?.data ? JSON.parse(base.data) : null, local, remote));
    }
    // yerelde silinmişse silme gönderilecek; birleştirilmiş kayıt da gönderilecek (outbox duruyor)
    setBase(tbl, pk, at, d);
    return true;
  }

  const cursor = () => {
    const at = meta('cursor_at');
    return at ? { at, name: meta('cursor_name') } : null;
  };

  async function pull() {
    let changed = 0;
    for (;;) {
      const docs = await client.runQuery('rows', { after: cursor() });
      if (!docs.length) break;
      applying(() => {
        for (const doc of docs) if (applyDoc(doc)) changed++;
        const last = docs[docs.length - 1];
        setMetaRaw('cursor_at', last.fields.at.timestampValue);
        setMetaRaw('cursor_name', last.name);
      });
      if (docs.length < PAGE) break;
    }
    return changed;
  }

  // Yeni sürümle gelen tablo / sütunlar: eski sürüm buluttaki bu bilgileri bilmediği için atlamıştı.
  // Güncellemeden önceki tablo yapısı (db-core: schema_before_update) varsa buluttaki kayıtlar bir kez daha okunur;
  // yalnızca güncellemeyle gelen tablolar ve sütunlar yerel kayıtlara işlenir, diğer bilgilere dokunulmaz.
  async function catchUpSchema() {
    const raw = meta('schema_before_update');
    if (!raw) return 0;
    let before;
    try {
      before = JSON.parse(raw);
    } catch {
      before = null;
    }
    let changed = 0;
    if (before) {
      const remote = await listAll();
      applying(() => {
        for (const doc of remote) {
          const f = doc.fields || {};
          const tbl = f.t?.stringValue;
          const pk = f.k?.stringValue;
          if (!tbl || pk === undefined || isLocalSetting(tbl, pk)) continue;
          const t = tables().get(tbl);
          if (!t) continue;
          const oldCols = before[tbl];
          if (!oldCols) {
            // Güncellemeyle gelen tablo (ör. malzeme kategorileri): normal şekilde işlenir
            if (applyDoc(doc)) changed++;
            continue;
          }
          const d = f.del?.booleanValue ? null : (f.d?.stringValue ?? null);
          if (!d) continue;
          const row = JSON.parse(d);
          const added = t.cols.filter((c) => !oldCols.includes(c) && Object.prototype.hasOwnProperty.call(row, c));
          if (!added.length) continue;
          const w = pkWhere(t, pk);
          if (!db.get(`SELECT 1 AS x FROM ${qi(tbl)} WHERE ${w.sql}`, w.params)) continue;
          db.db.run(`UPDATE ${qi(tbl)} SET ${added.map((c) => `${qi(c)} = ?`).join(', ')} WHERE ${w.sql}`, [...added.map((c) => row[c]), ...w.params]);
          changed++;
        }
      });
    }
    setMeta({ schema_before_update: null });
    return changed;
  }

  async function listAll() {
    const all = [];
    let after = null;
    for (;;) {
      const docs = await client.runQuery('rows', { after });
      all.push(...docs);
      if (docs.length < PAGE) break;
      const last = docs[docs.length - 1];
      after = { at: last.fields.at.timestampValue, name: last.name };
    }
    return all;
  }

  function rowWrite(tbl, pk, row, base) {
    const fields = {
      t: { stringValue: tbl },
      k: { stringValue: pk },
      d: { stringValue: row ? JSON.stringify(row) : '' },
      del: { booleanValue: !row },
      dev: { stringValue: meta('device_id') || '' },
    };
    return {
      update: { name: `${client.userRoot}/rows/${docId(tbl, pk)}`, fields },
      updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: base ? { updateTime: base.at } : { exists: false },
    };
  }

  async function push() {
    let sent = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const entries = db.all('SELECT tbl, pk, n FROM sync_outbox ORDER BY rowid LIMIT ?', [PUSH_BATCH]);
      if (!entries.length) break;
      const writes = [];
      const items = [];
      const extra = [];
      const drop = [];
      for (const e of entries) {
        const t = tables().get(e.tbl);
        if (!t || isLocalSetting(e.tbl, e.pk)) {
          drop.push(e);
          continue;
        }
        const row = readRow(e.tbl, e.pk);
        const base = getBase(e.tbl, e.pk);
        if (!row && (!base || base.data === null)) {
          drop.push(e);
          continue;
        }
        writes.push(rowWrite(e.tbl, e.pk, row, base));
        items.push({ e, data: row ? JSON.stringify(row) : null });
        // Silinen kaydın dosyası buluttan da silinir
        const fc = FILE_COLUMNS[e.tbl];
        if (!row && fc && base?.data) {
          const rel = JSON.parse(base.data)[fc];
          if (rel) extra.push(rel);
        }
      }
      if (drop.length) {
        db.tx(() => drop.forEach((e) => db.db.run('DELETE FROM sync_outbox WHERE tbl = ? AND pk = ? AND n = ?', [e.tbl, e.pk, e.n])));
      }
      if (!writes.length) continue;
      const fileDeletes = [];
      for (const rel of extra) {
        const parts = db.get('SELECT parts FROM sync_files WHERE rel = ?', [rel])?.parts || 1;
        fileDeletes.push({ delete: `${client.userRoot}/files/${fileDocId(rel)}` });
        for (let i = 1; i < parts; i++) fileDeletes.push({ delete: `${client.userRoot}/files/${fileDocId(rel)}~p${i}` });
      }
      const res = await client.commit([...writes, ...fileDeletes]);
      db.tx(() => {
        items.forEach(({ e, data }, i) => {
          setBase(e.tbl, e.pk, res.writeResults[i].updateTime, data);
          db.db.run('DELETE FROM sync_outbox WHERE tbl = ? AND pk = ? AND n = ?', [e.tbl, e.pk, e.n]);
        });
        extra.forEach((rel) => db.db.run('DELETE FROM sync_files WHERE rel = ?', [rel]));
      });
      sent += items.length;
    }
    return sent;
  }

  // Gönderirken başka cihaz aynı kaydı değiştirmişse: önce yenileri al, sonra tekrar gönder
  async function pushWithRetry() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await push();
      } catch (err) {
        if (err.code !== 'ERR_SYNC_CONFLICT' || attempt >= 4) throw err;
        await pull();
      }
    }
  }

  function referencedFiles() {
    const set = new Set();
    for (const [tbl, col] of Object.entries(FILE_COLUMNS)) {
      if (!tables().has(tbl)) continue;
      for (const r of db.all(`SELECT DISTINCT ${qi(col)} AS rel FROM ${qi(tbl)} WHERE ${qi(col)} IS NOT NULL AND ${qi(col)} <> ''`)) set.add(r.rel);
    }
    return set;
  }

  async function syncFiles() {
    // Silinen kayıtların dosyaları (başka kayıt kullanmıyorsa) telefondan / bilgisayardan da silinir
    const refs = referencedFiles();
    for (const rel of [...removedFiles]) {
      removedFiles.delete(rel);
      if (!refs.has(rel)) {
        try {
          await files.remove(rel);
        } catch {
          // dosya zaten yok
        }
      }
    }
    const known = new Map(db.all('SELECT rel, state, tried_at FROM sync_files').map((r) => [r.rel, r]));
    let done = 0;
    let pending = 0;
    for (const rel of refs) {
      const st = known.get(rel);
      if (st?.state === 'ok') continue;
      if (done >= FILES_PER_ROUND) {
        pending++;
        continue;
      }
      if (await files.exists(rel)) {
        const bytes = await files.read(rel);
        const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
        const writes = [];
        for (let i = 0; i < parts; i++) {
          const name = `${client.userRoot}/files/${fileDocId(rel)}${i ? `~p${i}` : ''}`;
          const fields = { data: { bytesValue: b64encode(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) } };
          if (!i) Object.assign(fields, { rel: { stringValue: rel }, size: { integerValue: String(bytes.length) }, parts: { integerValue: String(parts) } });
          writes.push({ update: { name, fields } });
        }
        // Firestore tek seferde ~10 MB kabul eder; parçalar gruplar halinde gönderilir
        for (let i = 0; i < writes.length; i += 8) await client.commit(writes.slice(i, i + 8));
        db.tx(() => db.db.run('INSERT INTO sync_files (rel, state, parts) VALUES (?, ?, ?) ON CONFLICT(rel) DO UPDATE SET state = excluded.state, parts = excluded.parts', [rel, 'ok', parts]));
        done++;
        continue;
      }
      if (st?.tried_at && Date.now() - st.tried_at < 5 * 60000) {
        pending++;
        continue;
      }
      const main = await client.getDoc(`${client.userRoot}/files/${fileDocId(rel)}`);
      if (!main) {
        db.tx(() => db.db.run('INSERT INTO sync_files (rel, state, tried_at) VALUES (?, ?, ?) ON CONFLICT(rel) DO UPDATE SET state = excluded.state, tried_at = excluded.tried_at', [rel, 'missing', Date.now()]));
        pending++;
        continue;
      }
      const parts = Number(main.fields.parts?.integerValue) || 1;
      const chunks = [b64decode(main.fields.data?.bytesValue || '')];
      for (let i = 1; i < parts; i++) {
        const p = await client.getDoc(`${client.userRoot}/files/${fileDocId(rel)}~p${i}`);
        if (!p) throw new SyncError('ERR_SYNC_SERVER', `eksik dosya parçası ${rel}`);
        chunks.push(b64decode(p.fields.data?.bytesValue || ''));
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      await files.write(rel, bytes);
      db.tx(() => db.db.run('INSERT INTO sync_files (rel, state, parts) VALUES (?, ?, ?) ON CONFLICT(rel) DO UPDATE SET state = excluded.state, parts = excluded.parts', [rel, 'ok', parts]));
      done++;
    }
    state.filesPending = pending;
    return done;
  }

  function localHasUserData() {
    return USER_TABLES.some((tbl) => tables().has(tbl) && db.get(`SELECT 1 AS x FROM ${qi(tbl)} LIMIT 1`));
  }

  async function cloudInfo() {
    const any = (await client.runQuery('rows', { limit: 1 })).length > 0;
    if (!any) return { any: false, user: false };
    const user = (await client.runQuery('rows', {
      limit: 1,
      ordered: false,
      where: { fieldFilter: { field: { fieldPath: 't' }, op: 'IN', value: { arrayValue: { values: USER_TABLES.map((s) => ({ stringValue: s })) } } } },
    })).length > 0;
    return { any, user };
  }

  // Bu cihazdaki kayıtlar buluta yüklenir (bulutta olup burada olmayanlar bulutta silinir)
  async function uploadAll(cloudAny) {
    const remote = cloudAny ? await listAll() : [];
    db.tx(() => {
      db.db.run('DELETE FROM sync_base');
      db.db.run('DELETE FROM sync_outbox');
      db.db.run('DELETE FROM sync_files');
      for (const doc of remote) {
        const tbl = doc.fields?.t?.stringValue;
        const pk = doc.fields?.k?.stringValue;
        if (!tbl || pk === undefined) continue;
        const d = doc.fields.del?.booleanValue ? null : (doc.fields.d?.stringValue ?? null);
        setBase(tbl, pk, doc.updateTime, d);
        if (d !== null) enqueue(tbl, pk);
      }
      for (const t of tables().values()) {
        for (const row of db.all(`SELECT * FROM ${qi(t.name)}`)) {
          const pk = pkOf(t, row);
          if (!isLocalSetting(t.name, pk)) enqueue(t.name, pk);
        }
      }
      const last = remote[remote.length - 1];
      setMetaRaw('cursor_at', last ? last.fields.at.timestampValue : null);
      setMetaRaw('cursor_name', last ? last.name : null);
    });
    await pushWithRetry();
  }

  // Bu cihazdaki kayıtların yerine buluttakiler gelir (önce yedek alınır)
  async function downloadAll() {
    const remote = await listAll();
    if (beforeReplace) await beforeReplace();
    applying(() => {
      for (const t of tables().values()) {
        if (t.name === 'settings') db.db.run(`DELETE FROM settings WHERE key NOT IN (${LOCAL_SETTINGS.map(qs).join(',')})`);
        else db.db.run(`DELETE FROM ${qi(t.name)}`);
      }
      db.db.run('DELETE FROM sync_base');
      db.db.run('DELETE FROM sync_outbox');
      db.db.run('DELETE FROM sync_files');
      for (const doc of remote) applyDoc(doc, { force: true });
      const last = remote[remote.length - 1];
      setMetaRaw('cursor_at', last ? last.fields.at.timestampValue : null);
      setMetaRaw('cursor_name', last ? last.name : null);
    });
  }

  function config() {
    return {
      apiKey: meta('api_key') || defaults.apiKey || '',
      projectId: meta('project_id') || defaults.projectId || '',
    };
  }

  function makeClient(cfg) {
    return new FirebaseClient({ apiKey: cfg.apiKey, projectId: cfg.projectId, fetch, endpoints });
  }

  function status() {
    const cfg = config();
    return {
      configured: !!(cfg.apiKey && cfg.projectId),
      builtInConfig: !!(defaults.apiKey && defaults.projectId),
      projectId: cfg.projectId,
      connected: !!meta('refresh_token'),
      email: meta('email'),
      deviceName: meta('device_name') || deviceName,
      lastSync: meta('last_sync'),
      pending: db.get('SELECT COUNT(*) AS n FROM sync_outbox')?.n ?? 0,
      filesPending: state.filesPending || 0,
      phase: state.phase,
      error: state.error,
      errorDetail: state.errorDetail,
    };
  }

  function emitStatus() {
    try {
      onStatus(status());
    } catch {
      // ekran kapalı olabilir
    }
  }

  // Bağlan: giriş yapar, buluttaki ve cihazdaki durumu karşılaştırır, ilk eşitlemeyi yapar.
  // choice: 'download' (buluttakini al) | 'upload' (bu cihazdakini gönder); ikisinde de kayıt varsa sorulur.
  async function connect({ apiKey, projectId, email, password, create = false, choice = null } = {}) {
    const cfg = { apiKey: (apiKey || config().apiKey || '').trim(), projectId: (projectId || config().projectId || '').trim() };
    if (!cfg.apiKey || !cfg.projectId) throw new SyncError('ERR_SYNC_NOT_CONFIGURED');
    if (!email || !password) throw new SyncError('ERR_REQUIRED');
    stop();
    await (running || Promise.resolve()).catch(() => {});
    const c = makeClient(cfg);
    const auth = await c.signIn(String(email).trim(), password, create);
    const previous = client;
    client = c;
    try {
      const cloud = await cloudInfo();
      const localUser = localHasUserData();
      let mode;
      if (!cloud.any) mode = 'upload';
      else if (!localUser) mode = 'download';
      else if (!cloud.user) mode = 'upload';
      else mode = choice;
      if (!mode) {
        client = previous;
        return { needsChoice: true };
      }
      setMeta({ device_id: meta('device_id') || randomId() });
      state.phase = 'syncing';
      emitStatus();
      if (mode === 'download') await downloadAll();
      else await uploadAll(cloud.any);
      setMeta({
        api_key: cfg.apiKey, project_id: cfg.projectId, email: auth.email, uid: auth.uid,
        refresh_token: c.refreshToken, last_sync: new Date().toISOString(), schema_before_update: null,
      });
      state.phase = 'idle';
      state.error = null;
      onChange();
      start();
      return { connected: true, mode };
    } catch (err) {
      client = previous;
      state.phase = 'idle';
      emitStatus();
      throw err;
    }
  }

  function disconnect() {
    stop();
    client = null;
    db.tx(() => {
      for (const k of ['refresh_token', 'uid', 'cursor_at', 'cursor_name', 'last_sync']) setMetaRaw(k, null);
      db.db.run('DELETE FROM sync_base');
      db.db.run('DELETE FROM sync_files');
    });
    state.phase = 'idle';
    state.error = null;
    emitStatus();
  }

  function ensureClient() {
    if (!client) {
      const cfg = config();
      const refreshToken = meta('refresh_token');
      if (!refreshToken || !cfg.apiKey || !cfg.projectId) return null;
      client = makeClient(cfg);
      client.refreshToken = refreshToken;
      client.uid = meta('uid');
    }
    return client;
  }

  // v1.19: güncelleme denetimi aynı oturumu kullanır (eşitleme bağlı değilse null)
  async function authedClient() {
    const c = ensureClient();
    if (!c) return null;
    await c.ensureToken();
    if (c === client && c.refreshToken !== meta('refresh_token')) setMeta({ refresh_token: c.refreshToken });
    return c;
  }

  async function round() {
    if (!ensureClient()) return { skipped: true };
    state.phase = 'syncing';
    emitStatus();
    try {
      await client.ensureToken();
      if (client.refreshToken !== meta('refresh_token')) setMeta({ refresh_token: client.refreshToken });
      const caught = await catchUpSchema();
      const pulled = (await pull()) + caught;
      const pushed = await pushWithRetry();
      const filesDone = await syncFiles();
      setMeta({ last_sync: new Date().toISOString() });
      state.phase = 'idle';
      state.error = null;
      state.errorDetail = null;
      if (pulled || filesDone) {
        state.lastChange = Date.now();
        onChange();
      }
      return { pulled, pushed, files: filesDone };
    } catch (err) {
      state.phase = err.code === 'ERR_SYNC_OFFLINE' ? 'offline' : 'error';
      state.error = err.code || 'ERR_SYNC_SERVER';
      state.errorDetail = err.detail || err.message;
      if (state.phase === 'error') log.error?.('eşitleme hatası', err.code, err.detail || err.message);
      throw err;
    } finally {
      emitStatus();
    }
  }

  // Aynı anda tek eşitleme turu çalışır; o sırada istek gelirse tur bitince bir kez daha çalışır
  function syncNow() {
    if (running) {
      again = true;
      return running;
    }
    running = round().finally(() => {
      running = null;
      if (again && !stopped) {
        again = false;
        schedule(500);
      }
    });
    return running;
  }

  function schedule(ms) {
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => syncNow().catch(() => {}), ms);
  }

  // Yerel kayıttan kısa süre sonra eşitle
  function poke() {
    if (stopped) return;
    if (!db.get('SELECT 1 AS x FROM sync_outbox LIMIT 1')) return;
    schedule(1500);
  }

  function start() {
    if (!meta('refresh_token')) return;
    stopped = false;
    clearInterval(timer);
    timer = setInterval(() => syncNow().catch(() => {}), intervalMs);
    schedule(300);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    clearTimeout(pokeTimer);
    timer = null;
  }

  installTriggers();
  const offCommit = db.onCommit ? db.onCommit(poke) : () => {};

  return {
    connect, disconnect, syncNow, start, stop, status, poke, authedClient,
    // testler ve ekran için
    isRunning: () => !!running,
    wait: () => running || Promise.resolve(),
    dispose: () => {
      stop();
      offCommit();
    },
    resetTableCache: () => {
      tableCache = null;
    },
  };
}

module.exports = { createSync, SyncError, FirebaseClient, USER_TABLES, LOCAL_SETTINGS, COUNTERS, FILE_COLUMNS };
