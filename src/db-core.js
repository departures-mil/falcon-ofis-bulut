// Masaüstü ve telefonun ortak veritabanı katmanı (sql.js). Dosyaya / telefona kaydetme işi alt sınıflarda.
const { migrations } = require('./schema');

// Kayıt numaraları cihazlar arasında çakışmasın diye zamana dayalı üretilir:
// (2025'ten beri geçen saniye) * 1.000.000 + rastgele sayı. Sıralama yine eskiden yeniye doğrudur.
const ID_EPOCH = 1735689600;
let lastId = 0;
function newRowId() {
  let id = (Math.floor(Date.now() / 1000) - ID_EPOCH) * 1e6 + Math.floor(Math.random() * 1e6);
  if (id <= lastId) id = lastId + 1;
  lastId = id;
  return id;
}

const INSERT_RE = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*\(/i;

class DatabaseCore {
  constructor({ backupWriter = null } = {}) {
    // backupWriter(fromVersion, rawBytes): yeni sürüm şemayı değiştirmeden önce eski veritabanının kopyası
    this.backupWriter = backupWriter;
    this.rawOnOpen = null;
    this.db = null;
    this.txDepth = 0;
    this.idTables = null;
    this.listeners = new Set();
  }

  // SQL: initSqlJs sonucu, raw: mevcut veritabanı baytları (yoksa null)
  openWith(SQL, raw) {
    this.rawOnOpen = raw || null;
    this.db = raw ? new SQL.Database(raw) : new SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
    this.migrate();
    return this;
  }

  migrate() {
    this.db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    const applied = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version));
    let changed = false;
    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length && this.rawOnOpen && applied.size && this.backupWriter) {
      this.backupWriter(Math.max(...applied), this.rawOnOpen);
    }
    this.rawOnOpen = null;
    // Eşitleme için: güncellemeden önceki tablo / sütun yapısı (yeni sütunlar buluttan bir kez daha alınır)
    if (pending.length && applied.size && this.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_meta'")) {
      const shape = {};
      for (const { name } of this.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
        shape[name] = this.all(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).map((c) => c.name);
      }
      this.db.run("INSERT INTO sync_meta (key, value) VALUES ('schema_before_update', ?) ON CONFLICT(key) DO NOTHING", [JSON.stringify(shape)]);
    }
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      this.db.run('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, datetime('now','localtime'))", [m.version, m.name]);
        this.db.run('COMMIT');
        changed = true;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
      }
    }
    if (changed) this.save();
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] ?? null;
  }

  // "id INTEGER PRIMARY KEY" sütunu olan tablolar
  tablesWithRowId() {
    if (!this.idTables) {
      this.idTables = new Set();
      for (const { name } of this.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
        const cols = this.all(`PRAGMA table_info(${name})`);
        const pk = cols.filter((c) => c.pk > 0);
        if (pk.length === 1 && pk[0].name === 'id' && /INT/i.test(pk[0].type)) this.idTables.add(name);
      }
    }
    return this.idTables;
  }

  run(sql, params = []) {
    // Yeni kayda numarası burada verilir (bkz. newRowId)
    const m = INSERT_RE.exec(sql);
    if (m && this.tablesWithRowId().has(m[1]) && !/(^|,)\s*id\s*(,|$)/i.test(m[2])) {
      const rewritten = `INSERT INTO ${m[1]} (id, ${m[2]}) VALUES (?, ${sql.slice(m[0].length)}`;
      for (let attempt = 0; ; attempt++) {
        const id = newRowId();
        try {
          return this.exec(rewritten, [id, ...params]);
        } catch (err) {
          if (attempt < 3 && /UNIQUE constraint failed: \w+\.id\b/.test(err.message)) continue;
          throw err;
        }
      }
    }
    return this.exec(sql, params);
  }

  exec(sql, params = []) {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    const lastId = this.get('SELECT last_insert_rowid() AS id').id;
    if (this.txDepth === 0) this.committed();
    return { lastInsertRowid: lastId, changes };
  }

  // fn içindeki bütün yazmalar tek işlem: hata olursa hiçbiri kaydedilmez.
  tx(fn) {
    if (this.txDepth > 0) return fn();
    this.db.run('BEGIN');
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.db.run('COMMIT');
      this.committed();
      return result;
    } catch (err) {
      this.txDepth--;
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  // Birden fazla yazma işlemini tek seferde, ya hepsi ya hiçbiri olarak çalıştırır.
  transaction(statements) {
    return this.tx(() => statements.map(({ sql, params = [] }) => this.run(sql, params)));
  }

  committed() {
    this.save();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // dinleyici hatası kaydı etkilemez
      }
    }
  }

  // Her kayıttan sonra çağrılır (eşitleme bunu kullanarak değişiklikleri hemen gönderir)
  onCommit(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  export() {
    const data = this.db.export();
    // sql.js export() veritabanını yeniden açar ve PRAGMA ayarlarını sıfırlar.
    this.db.run('PRAGMA foreign_keys = ON;');
    return data;
  }

  save() {
    throw new Error('save() alt sınıfta tanımlanmalı');
  }
}

module.exports = { DatabaseCore, newRowId, ID_EPOCH };
