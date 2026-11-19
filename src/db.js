// SQLite veritabanı (sql.js). Veri dosyası kullanıcının bilgisayarında,
// uygulama veri klasöründe saklanır; her yazma işleminden sonra diske kaydedilir.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { DatabaseCore } = require('./db-core');

class Database extends DatabaseCore {
  // backupDir: yeni sürüm şemayı değiştirmeden önce eski veritabanının kopyası buraya alınır
  constructor(filePath, { backupDir = null } = {}) {
    super({
      backupWriter: backupDir
        ? (from, raw) => {
          fs.mkdirSync(backupDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fs.writeFileSync(path.join(backupDir, `guncelleme-oncesi-v${from}-${stamp}.db`), raw);
        }
        : null,
    });
    this.filePath = filePath;
    this.backupDir = backupDir;
  }

  async open() {
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    const SQL = await initSqlJs({ wasmBinary });
    const exists = fs.existsSync(this.filePath);
    return this.openWith(SQL, exists ? fs.readFileSync(this.filePath) : null);
  }

  // Önce geçici dosyaya yazıp sonra yer değiştirir; elektrik kesilirse veri bozulmaz.
  save() {
    const data = Buffer.from(this.export());
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  close() {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { Database };
