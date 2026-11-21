// Falcon Ofis veritabanı şeması.
// Her sürüm bir kez uygulanır; yeni tablolar için listeye yeni sürüm eklenir.

const migrations = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      -- Genel ayarlar (dil, kur kaynağı vb.)
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Para birimleri: USD, TRY, SYP
      CREATE TABLE currencies (
        code       TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        symbol     TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      -- Kurlar: 1 USD = rate birim. Kaynak elle (manual) veya internet (online).
      CREATE TABLE exchange_rates (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        currency_code TEXT NOT NULL REFERENCES currencies(code),
        rate          REAL NOT NULL CHECK (rate > 0),
        source        TEXT NOT NULL CHECK (source IN ('manual','online')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX idx_rates_currency ON exchange_rates(currency_code, created_at);

      -- Kasalar: her para birimi için bir kasa
      CREATE TABLE cash_accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        currency_code   TEXT NOT NULL REFERENCES currencies(code),
        opening_balance REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Kişiler: borç, hediye, kâr payı ve tedarikçi/müşteri kayıtlarında kullanılır
      CREATE TABLE people (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        phone      TEXT,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Para trafiği: kasaya giren / kasadan çıkan her hareket
      CREATE TABLE cash_transactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   INTEGER NOT NULL REFERENCES cash_accounts(id),
        direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
        amount       REAL NOT NULL CHECK (amount >= 0),
        date         TEXT NOT NULL,
        category     TEXT NOT NULL DEFAULT 'other',
        person_id    INTEGER REFERENCES people(id),
        description  TEXT,
        related_type TEXT,   -- 'purchase' | 'sale' | 'debt' | 'debt_payment' | 'gift' | 'profit_share' | 'asset' | 'material'
        related_id   INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at   TEXT
      );
      CREATE INDEX idx_cash_tx_account ON cash_transactions(account_id, date);
      CREATE INDEX idx_cash_tx_related ON cash_transactions(related_type, related_id);

      -- Dekontlar: giden paralara bağlı PDF / JPEG / PNG dosyaları
      CREATE TABLE receipts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL REFERENCES cash_transactions(id) ON DELETE CASCADE,
        file_path      TEXT NOT NULL,   -- uygulama veri klasörüne göre göreli yol
        original_name  TEXT,
        mime_type      TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Borç / alacak: şirketin aldığı (borrowed) veya verdiği (lent) borçlar
      CREATE TABLE debts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id     INTEGER NOT NULL REFERENCES people(id),
        direction     TEXT NOT NULL CHECK (direction IN ('borrowed','lent')),
        amount        REAL NOT NULL CHECK (amount > 0),
        currency_code TEXT NOT NULL REFERENCES currencies(code),
        date          TEXT NOT NULL,
        due_date      TEXT,
        description   TEXT,
        status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE debt_payments (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        debt_id             INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
        amount              REAL NOT NULL CHECK (amount > 0),
        date                TEXT NOT NULL,
        cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL,
        note                TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Hediye / bağış olarak verilen paralar
      CREATE TABLE gifts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id           INTEGER NOT NULL REFERENCES people(id),
        amount              REAL NOT NULL CHECK (amount > 0),
        currency_code       TEXT NOT NULL REFERENCES currencies(code),
        date                TEXT NOT NULL,
        description         TEXT,
        cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Depo / raf / şube gibi konumlar
      CREATE TABLE locations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        description TEXT
      );

      -- Ürünler (alınıp satılan mallar)
      CREATE TABLE products (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        code        TEXT UNIQUE,
        category    TEXT,
        unit        TEXT NOT NULL DEFAULT 'pcs',
        description TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at  TEXT
      );

      CREATE TABLE product_images (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        file_path  TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Hangi ürün hangi konumda kaç adet
      CREATE TABLE product_stock (
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id),
        quantity    REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, location_id)
      );

      -- Alışlar: tarih, adet, birim fiyat (düzenlenebilir)
      CREATE TABLE purchases (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id          INTEGER NOT NULL REFERENCES products(id),
        location_id         INTEGER REFERENCES locations(id),
        supplier_id         INTEGER REFERENCES people(id),
        date                TEXT NOT NULL,
        quantity            REAL NOT NULL CHECK (quantity > 0),
        unit_price          REAL NOT NULL CHECK (unit_price >= 0),
        currency_code       TEXT NOT NULL REFERENCES currencies(code),
        note                TEXT,
        cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at          TEXT
      );
      CREATE INDEX idx_purchases_product ON purchases(product_id, date);

      -- Satışlar: adet stoktan düşer, kâr hesaplanır
      CREATE TABLE sales (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id          INTEGER NOT NULL REFERENCES products(id),
        location_id         INTEGER REFERENCES locations(id),
        customer_id         INTEGER REFERENCES people(id),
        date                TEXT NOT NULL,
        quantity            REAL NOT NULL CHECK (quantity > 0),
        unit_price          REAL NOT NULL CHECK (unit_price >= 0),
        unit_cost           REAL NOT NULL DEFAULT 0,  -- satış anındaki birim maliyet
        currency_code       TEXT NOT NULL REFERENCES currencies(code),
        profit              REAL NOT NULL DEFAULT 0,  -- (unit_price - unit_cost) * quantity
        note                TEXT,
        cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at          TEXT
      );
      CREATE INDEX idx_sales_product ON sales(product_id, date);

      -- Satış kârının kişilere yüzde ile paylaştırılması
      CREATE TABLE sale_profit_shares (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        person_id  INTEGER NOT NULL REFERENCES people(id),
        percentage REAL NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
        amount     REAL NOT NULL DEFAULT 0,
        paid       INTEGER NOT NULL DEFAULT 0,
        cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL
      );

      -- Malzemeler (sarf malzemesi, hammadde)
      CREATE TABLE materials (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        code         TEXT UNIQUE,
        unit         TEXT NOT NULL DEFAULT 'pcs',
        quantity     REAL NOT NULL DEFAULT 0,
        min_quantity REAL NOT NULL DEFAULT 0,
        location_id  INTEGER REFERENCES locations(id),
        image_path   TEXT,
        note         TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at   TEXT
      );

      -- Malzeme girdi / çıktı hareketleri
      CREATE TABLE material_movements (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id   INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
        quantity      REAL NOT NULL CHECK (quantity > 0),
        date          TEXT NOT NULL,
        unit_price    REAL,
        currency_code TEXT REFERENCES currencies(code),
        person_id     INTEGER REFERENCES people(id),
        note          TEXT,
        cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- Demirbaşlar
      CREATE TABLE fixed_assets (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL,
        asset_code     TEXT UNIQUE,
        category       TEXT,
        serial_no      TEXT,
        purchase_date  TEXT,
        purchase_price REAL,
        currency_code  TEXT REFERENCES currencies(code),
        location_id    INTEGER REFERENCES locations(id),
        assigned_to    INTEGER REFERENCES people(id),
        status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','repair','retired','lost')),
        image_path     TEXT,
        note           TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at     TEXT
      );

      -- Başlangıç verileri
      INSERT INTO currencies (code, name, symbol, sort_order) VALUES
        ('USD', 'US Dollar', '$', 1),
        ('TRY', 'Türk Lirası', '₺', 2),
        ('SYP', 'Syrian Pound', 'ل.س', 3);

      INSERT INTO cash_accounts (name, currency_code) VALUES
        ('Dolar Kasası', 'USD'),
        ('TL Kasası', 'TRY'),
        ('Suriye Lirası Kasası', 'SYP');

      INSERT INTO exchange_rates (currency_code, rate, source) VALUES ('USD', 1, 'manual');

      INSERT INTO locations (name) VALUES ('Ana Depo');

      INSERT INTO settings (key, value) VALUES
        ('language', 'tr'),
        ('rate_source', 'manual');
    `,
  },
];

module.exports = { migrations };

migrations.push({
  version: 2,
  name: 'cash-links',
  sql: `
    ALTER TABLE debts ADD COLUMN cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL;
    ALTER TABLE fixed_assets ADD COLUMN cash_transaction_id INTEGER REFERENCES cash_transactions(id) ON DELETE SET NULL;
    ALTER TABLE sale_profit_shares ADD COLUMN paid_date TEXT;
    INSERT OR IGNORE INTO settings (key, value) VALUES ('rate_auto_update', '0');
  `,
});

migrations.push({
  version: 3,
  name: 'v1.1-buy-sell-contacts-share-defaults',
  sql: `
    -- Alış / satış kuru. rate sütunu toplam dolar hesabında kullanılan değerdir (satış kuru).
    ALTER TABLE exchange_rates ADD COLUMN buy_rate REAL;
    ALTER TABLE exchange_rates ADD COLUMN sell_rate REAL;

    -- Kişiye nasıl ulaşılır: {"whatsapp":1,"telegram":0,...}
    ALTER TABLE people ADD COLUMN contacts TEXT;

    -- Her satışta otomatik uygulanan varsayılan kâr paylaşımı
    CREATE TABLE profit_share_defaults (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      percentage REAL NOT NULL CHECK (percentage > 0 AND percentage <= 100)
    );
  `,
});

migrations.push({
  version: 4,
  name: 'v1.2-info-only-cash',
  sql: `
    -- Yalnızca bilgi amaçlı kasa kaydı: listede görünür, kasa bakiyesine ve toplamlara eklenmez
    ALTER TABLE cash_transactions ADD COLUMN info_only INTEGER NOT NULL DEFAULT 0;
  `,
});

migrations.push({
  version: 5,
  name: 'v1.3-sync',
  sql: `
    -- Telefon / bilgisayar eşitlemesi (bulut). Bu tablolar cihaza özeldir, buluta gönderilmez.
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT);
    -- Buluta henüz gönderilmemiş değişiklikler (tablo + kayıt anahtarı)
    CREATE TABLE IF NOT EXISTS sync_outbox (tbl TEXT NOT NULL, pk TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tbl, pk));
    -- Kaydın bulutta bilinen son hali (iki cihazda aynı anda yapılan değişiklikleri birleştirmek için)
    CREATE TABLE IF NOT EXISTS sync_base (tbl TEXT NOT NULL, pk TEXT NOT NULL, at TEXT NOT NULL, data TEXT, PRIMARY KEY (tbl, pk));
    -- Fotoğraf / dekont dosyalarının bulut durumu
    CREATE TABLE IF NOT EXISTS sync_files (rel TEXT PRIMARY KEY, state TEXT NOT NULL, parts INTEGER, tried_at INTEGER);
    CREATE TABLE IF NOT EXISTS sync_flag (applying INTEGER NOT NULL);
    INSERT INTO sync_flag (applying) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM sync_flag);
  `,
});

migrations.push({
  version: 6,
  name: 'v1.4-categories-cost-photos',
  sql: `
    -- Ürün: yeni / ikinci el, maliyet (USD / TRY / SYP) ve hedef kâr yüzdesi
    ALTER TABLE products ADD COLUMN condition TEXT;
    ALTER TABLE products ADD COLUMN cost_price REAL;
    ALTER TABLE products ADD COLUMN cost_currency TEXT;
    ALTER TABLE products ADD COLUMN profit_pct REAL;

    -- Demirbaş fotoğrafları (birden fazla, biri ana fotoğraf). image_path ana fotoğrafı tutmaya devam eder.
    CREATE TABLE asset_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id   INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
      file_path  TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    -- Eski tek fotoğraf korunur: numarası demirbaşın numarasıyla aynı olur (iki cihazda da aynı kayıt oluşur)
    INSERT INTO asset_images (id, asset_id, file_path, is_primary)
      SELECT id, id, image_path, 1 FROM fixed_assets WHERE image_path IS NOT NULL AND image_path <> '';
    INSERT INTO sync_outbox (tbl, pk) SELECT 'asset_images', CAST(id AS TEXT) FROM asset_images WHERE 1
      ON CONFLICT(tbl, pk) DO NOTHING;

    -- Alış / satış görselleri ve dekontları
    CREATE TABLE trade_files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id   INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
      sale_id       INTEGER REFERENCES sales(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL CHECK (kind IN ('image','receipt')),
      file_path     TEXT NOT NULL,
      original_name TEXT,
      mime_type     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_trade_files_purchase ON trade_files(purchase_id);
    CREATE INDEX idx_trade_files_sale ON trade_files(sale_id);
  `,
});

migrations.push({
  version: 7,
  name: 'v1.5-sale-price-material-categories',
  sql: `
    -- Ürün: doğrudan girilen satış fiyatı (maliyet varsa kâr yüzdesi bundan hesaplanır)
    ALTER TABLE products ADD COLUMN sale_price REAL;
    UPDATE products SET sale_price = ROUND(cost_price * (1 + profit_pct / 100.0), 2)
      WHERE cost_price IS NOT NULL AND profit_pct IS NOT NULL;

    -- Malzeme kategorileri ve alt kategorileri (ör. Filamentler > PETG)
    CREATE TABLE material_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      parent_id  INTEGER REFERENCES material_categories(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_material_categories_parent ON material_categories(parent_id);
    ALTER TABLE materials ADD COLUMN category_id INTEGER REFERENCES material_categories(id) ON DELETE SET NULL;
  `,
});

migrations.push({
  version: 8,
  name: 'v1.9-material-condition',
  sql: `
    -- Malzeme durumu (filamentlerde sıfır / kullanılmış): 'new' | 'used' | NULL
    ALTER TABLE materials ADD COLUMN condition TEXT;
  `,
});

migrations.push({
  version: 9,
  name: 'v1.10-nakit-para',
  sql: `
    -- Nakit para: kasalardan ayrı tutulan elde nakit (USD, TL, SYP). Hareketleri ortak para trafiğindedir,
    -- toplam kasa durumuna eklenir. kind: 'box' = kasa, 'cash' = nakit
    ALTER TABLE cash_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'box';
    -- Sabit numaralar: bilgisayar ve telefon aynı üç kaydı oluşturur, eşitlemede çift olmaz
    INSERT OR IGNORE INTO cash_accounts (id, name, currency_code, kind) VALUES
      (101, 'Nakit Dolar', 'USD', 'cash'),
      (102, 'Nakit TL', 'TRY', 'cash'),
      (103, 'Nakit Suriye Lirası', 'SYP', 'cash');
  `,
});

migrations.push({
  version: 10,
  name: 'v1.11-konum-sirasi',
  sql: `
    -- Depo ve konumların sırası (Ayarlar'da yukarı / aşağı). Boş olanlar ada göre sona dizilir.
    ALTER TABLE locations ADD COLUMN sort_order INTEGER;
  `,
});

migrations.push({
  version: 11,
  name: 'v1.12-kripto-kasalar',
  sql: `
    -- Kripto para kasaları: USDT (BEP20), Bitcoin, Ethereum. Kur satırında rate = 1 dolar kaç birim (diğerleri gibi);
    -- dolar karşılığı piyasa fiyatından hesaplanır ve toplam kasa durumuna eklenir.
    INSERT OR IGNORE INTO currencies (code, name, symbol, sort_order) VALUES
      ('USDT', 'Tether USDT (BEP20)', '₮', 4),
      ('BTC', 'Bitcoin', '₿', 5),
      ('ETH', 'Ethereum', 'Ξ', 6);
    -- Sabit numaralar: bilgisayar ve telefon aynı kayıtları oluşturur, eşitlemede çift olmaz
    INSERT OR IGNORE INTO cash_accounts (id, name, currency_code, kind) VALUES
      (104, 'USDT (BEP20)', 'USDT', 'box'),
      (105, 'BTC (Bitcoin)', 'BTC', 'box'),
      (106, 'ETH (Ethereum)', 'ETH', 'box');
  `,
});

migrations.push({
  version: 12,
  name: 'v1.13-kasa-gizleme',
  sql: `
    -- Kasa kutusu gizleme: kayıtlar ve hareketler silinmez; gizli kutu Genel Bakış ve Kasa kartlarında görünmez,
    -- toplam dolar hesabına girmez, yeni hareketlerde seçilmez. Ayarlar > Kasa kutuları'ndan tekrar gösterilebilir.
    ALTER TABLE cash_accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
    -- kullanıcının isteği (v1.13): "Sham Cash TL" adlı kutu kaldırılır (gizlenir)
    UPDATE cash_accounts SET hidden = 1 WHERE lower(trim(name)) = 'sham cash tl';
  `,
});

migrations.push({
  version: 13,
  name: 'v1.14-qr-barkod',
  sql: `
    -- QR / barkod sistemi. Her ürün, malzeme ve demirbaşa kısa bir seri numarası verilir
    -- (U-00001 ürün, M-00001 malzeme, D-00001 demirbaş); etiketteki QR kod bu numarayı taşır.
    -- Mevcut kayıtlara kayıt sırasıyla numara verilir; başka hiçbir bilgi değişmez.
    ALTER TABLE products ADD COLUMN serial TEXT;
    ALTER TABLE materials ADD COLUMN serial TEXT;
    ALTER TABLE fixed_assets ADD COLUMN serial TEXT;
    UPDATE products SET serial = (SELECT 'U-' || printf('%05d', x.rn) FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM products) x WHERE x.id = products.id) WHERE serial IS NULL;
    UPDATE materials SET serial = (SELECT 'M-' || printf('%05d', x.rn) FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM materials) x WHERE x.id = materials.id) WHERE serial IS NULL;
    UPDATE fixed_assets SET serial = (SELECT 'D-' || printf('%05d', x.rn) FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM fixed_assets) x WHERE x.id = fixed_assets.id) WHERE serial IS NULL;
    CREATE UNIQUE INDEX idx_products_serial ON products(serial);
    CREATE UNIQUE INDEX idx_materials_serial ON materials(serial);
    CREATE UNIQUE INDEX idx_fixed_assets_serial ON fixed_assets(serial);

    -- Kayda eklenen hazır barkod / QR kodları (üretici barkodu vb.); görseli (fotoğraf) de saklanabilir
    CREATE TABLE item_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type  TEXT NOT NULL CHECK (item_type IN ('product','material','asset')),
      item_id    INTEGER NOT NULL,
      code       TEXT NOT NULL,
      format     TEXT,
      image_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_item_codes_code ON item_codes(code);
    CREATE INDEX idx_item_codes_item ON item_codes(item_type, item_id);
  `,
});

migrations.push({
  version: 14,
  name: 'v1.15-kripto-cuzdan-takibi',
  sql: `
    -- Kripto cüzdan takibi (yalnızca okuma): herkese açık alma (Receive) adresleri. Gizli kelime / anahtar saklanmaz.
    -- watch_from: adresin eklendiği an; yalnızca bundan sonraki hareketler kasaya işlenir (eski bakiye iki kez sayılmaz).
    CREATE TABLE crypto_wallets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      coin       TEXT NOT NULL CHECK (coin IN ('USDT','BTC','ETH')),
      address    TEXT NOT NULL,
      label      TEXT,
      watch_from TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    -- Görülen her hareket (gelen / giden) işlem numarasıyla (tx) bir kez yazılır; iki cihaz aynı ödemeyi bulsa da tek kayıt olur.
    -- Kasa kaydı sonradan elle silinse bile hareket tekrar eklenmez. Giden ödemelerde ağ ücreti (fee) tutara dahildir.
    CREATE TABLE crypto_wallet_tx (
      txid        TEXT PRIMARY KEY,
      coin        TEXT NOT NULL,
      address     TEXT NOT NULL,
      tx_hash     TEXT NOT NULL,
      direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
      amount      REAL NOT NULL,
      fee         REAL NOT NULL DEFAULT 0,
      tx_time     TEXT NOT NULL,
      cash_tx_id  INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_crypto_wallet_tx_coin ON crypto_wallet_tx(coin, tx_time);
    -- Bu cihazın kontrol durumu (son kontrol, hata, taranan blok); buluta gönderilmez
    CREATE TABLE local_wallet_state (
      wallet_id  INTEGER PRIMARY KEY,
      state      TEXT,
      last_check TEXT,
      last_error TEXT,
      source     TEXT
    );
  `,
});

migrations.push({
  version: 15,
  name: 'v1.17-kasa-kategorileri',
  sql: `
    -- Kasa hareketi kategorileri artık düzenlenebilir: ekle, adını değiştir, sil (gizle), sırala.
    -- key: harekette saklanan değer (cash_transactions.category). Hazır kategoriler aynı numara ve anahtarla oluşur
    -- (her cihazda aynı, eşitlemede çift olmaz); name boşsa adı seçili dilden gelir.
    -- Silinen kategori gizlenir (hidden = 1): onu kullanan eski hareketler adıyla görünmeye devam eder.
    CREATE TABLE cash_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL,
      name       TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      hidden     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX idx_cash_categories_key ON cash_categories(key);
    INSERT OR IGNORE INTO cash_categories (id, key, sort_order) VALUES
      (1, 'capital', 1), (2, 'sale', 2), (3, 'purchase', 3), (4, 'expense', 4), (5, 'salary', 5), (6, 'rent', 6),
      (7, 'bill', 7), (8, 'debt', 8), (9, 'gift', 9), (10, 'profit_share', 10), (11, 'material', 11), (12, 'asset', 12),
      (13, 'transfer', 13), (14, 'crypto_in', 14), (15, 'crypto_out', 15), (16, 'other', 16);
  `,
});

migrations.push({
  version: 16,
  name: 'v1.18-alt-kategori',
  sql: `
    -- Alt kategori: bir kategorinin altına başka kategori (ör. Gider › VPN hizmeti). Tek seviye.
    -- Var olan kategoriler üst seviyede kalır; hiçbir hareket değişmez.
    ALTER TABLE cash_categories ADD COLUMN parent_id INTEGER;
  `,
});

migrations.push({
  version: 17,
  name: 'v1.23-internet',
  sql: `
    -- Ofis interneti: sağlayıcı, hız, aylık ücret, ödemenin geçerli olduğu son gün (paid_until) ve kaç gün önce hatırlatılacağı.
    -- Ödeme yapılacak şirketin QR kodu görseli (qr_path) ve iletişim bilgileri; WhatsApp / Telegram ile ulaşılabiliyor mu
    -- (1 = çalışıyor, 0 = çalışmıyor, NULL = bilinmiyor) ve en son ne zaman denendiği.
    CREATE TABLE internet_services (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      provider         TEXT NOT NULL,
      speed            TEXT,
      price            REAL,
      currency_code    TEXT,
      paid_until       TEXT,
      remind_days      INTEGER NOT NULL DEFAULT 3,
      phone            TEXT,
      whatsapp         TEXT,
      whatsapp_ok      INTEGER,
      whatsapp_checked TEXT,
      telegram         TEXT,
      telegram_ok      INTEGER,
      telegram_checked TEXT,
      contact_note     TEXT,
      qr_path          TEXT,
      note             TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at       TEXT
    );
    -- Her ödeme süreyi ay ay uzatır; silinirse süre önceki haline (prev_until) döner
    CREATE TABLE internet_payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id          INTEGER NOT NULL,
      date                TEXT NOT NULL,
      months              INTEGER NOT NULL DEFAULT 1,
      amount              REAL,
      currency_code       TEXT,
      prev_until          TEXT,
      new_until           TEXT NOT NULL,
      cash_transaction_id INTEGER,
      note                TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_internet_payments_service ON internet_payments(service_id, date);
  `,
});

migrations.push({
  version: 18,
  name: 'v1.26-elektrik',
  sql: `
    -- Elektrik sayacı: adı (ör. Ofis), sayaç numarası, sayacın fotoğrafı
    CREATE TABLE electricity_meters (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      meter_no   TEXT,
      photo_path TEXT,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT
    );
    -- Sayaçta görülen değer (kWh) ve o anki fotoğraf; ikisi arasındaki fark harcanan elektriktir
    CREATE TABLE electricity_readings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id   INTEGER NOT NULL,
      date       TEXT NOT NULL,
      reading    REAL NOT NULL,
      photo_path TEXT,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_electricity_readings_meter ON electricity_readings(meter_id, date);
  `,
});

migrations.push({
  version: 19,
  name: 'v1.38-cuzdan-aglari',
  sql: `
    -- v1.38: USDT için Ethereum (ERC20) ve Tron (TRC20) ağları. Her ağın kendi kasa kutusu var (sabit numara: eşitlemede çift olmaz).
    -- crypto_wallets.network: bsc | eth | tron | btc (eski kayıtlarda boş = coin'in varsayılan ağı: USDT→bsc, ETH→eth, BTC→btc)
    ALTER TABLE crypto_wallets ADD COLUMN network TEXT;
    ALTER TABLE crypto_wallet_tx ADD COLUMN network TEXT;
    INSERT OR IGNORE INTO cash_accounts (id, name, currency_code, kind) VALUES
      (107, 'USDT (ERC20)', 'USDT', 'box'),
      (108, 'USDT (TRC20)', 'USDT', 'box');
  `,
});

migrations.push({
  version: 20,
  name: 'v1.39-not-defteri',
  sql: `
    -- v1.39: Dahili not defteri. Notlar telefonla bilgisayar arasında eşitlenir.
    -- pinned = 1: başa sabitlenmiş not. color: kart rengi (boş = varsayılan).
    CREATE TABLE notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT,
      body       TEXT,
      pinned     INTEGER NOT NULL DEFAULT 0,
      color      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT
    );
    CREATE INDEX idx_notes_updated ON notes(pinned, updated_at);
  `,
});

migrations.push({
  version: 21,
  name: 'v1.40-malzeme-yerleri',
  sql: `
    -- v1.40: Malzeme yerleri (konumun içindeki dolap / raf / kat). Ağaç yapısı: 3D Dolabı > Üst Kat.
    -- location_id yalnızca en üstteki yerde tutulur (alt yerler üst yerin konumunu kullanır); boşsa her konumda seçilebilir.
    CREATE TABLE material_places (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      parent_id   INTEGER,
      location_id INTEGER,
      sort_order  INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at  TEXT
    );
    CREATE INDEX idx_material_places_parent ON material_places(parent_id);
    ALTER TABLE materials ADD COLUMN place_id INTEGER;
    -- Başlangıç yerleri (sabit numaralı: iki cihazda da aynı kayıt olur, eşitlemede çift olmaz)
    INSERT OR IGNORE INTO material_places (id, name, parent_id, location_id, sort_order) VALUES
      (1, '3D Dolabı', NULL, (SELECT id FROM locations WHERE name = 'AMTN Home' LIMIT 1), 1),
      (2, 'Üst Kat', 1, NULL, 1),
      (3, 'Orta Kat', 1, NULL, 2),
      (4, 'Alt Kat', 1, NULL, 3);
  `,
});

migrations.push({
  version: 22,
  name: 'v1.42-coklu-kisi',
  sql: `
    -- v1.42: Bir kasa hareketine (harcama, gider, gelir) birden fazla kişi. person_id ilk kişidir (eski sürümler ve
    -- raporlar onu görür); people_ids bütün kişilerin numaralarını JSON dizi olarak tutar ([12, 40, 7]). Tek kişide boştur.
    ALTER TABLE cash_transactions ADD COLUMN people_ids TEXT;
  `,
});

migrations.push({
  version: 23,
  name: 'v1.43-cuzdan-listesi',
  sql: `
    -- v1.43: Cüzdanlarda tam liste (LTC, DOGE, TRX, XRP, TON, USDC …). Eski tabloda coin yalnızca USDT/BTC/ETH olabiliyordu
    -- (CHECK kısıtı); tablo aynı sütunlar ve aynı kayıtlarla kısıtsız olarak yeniden kurulur. Kayıt numaraları değişmez.
    CREATE TABLE crypto_wallets_v143 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      coin       TEXT NOT NULL,
      address    TEXT NOT NULL,
      label      TEXT,
      watch_from TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      network    TEXT
    );
    INSERT INTO crypto_wallets_v143 (id, coin, address, label, watch_from, created_at, network)
      SELECT id, coin, address, label, watch_from, created_at, network FROM crypto_wallets;
    DROP TABLE crypto_wallets;
    ALTER TABLE crypto_wallets_v143 RENAME TO crypto_wallets;
  `,
});

migrations.push({
  version: 24,
  name: 'v1.46-duzenli-odemeler',
  sql: `
    -- v1.46: Düzenli ödemeler. kind = 'infak' (Finans > Düzenli İnfak) ya da 'aidat' (Sistem > Aidat).
    -- title: nereye / ne için, recipient: kime. Sıklık period_count × period_unit (day | week | month | year).
    -- next_date: sıradaki ödeme (hatırlatma) tarihi; remind_days gün önceden hatırlatılır. active = 0: hatırlatma yok.
    -- qr_path: Sham Cash hesabının QR kodu, account_no: Sham Cash hesap numarası / adresi.
    -- contacts: JSON [{"label":"…","number":"…","apps":["whatsapp","telegram","signal","shamcash","call"]}]
    CREATE TABLE recurring_plans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL DEFAULT 'infak',
      title         TEXT NOT NULL,
      recipient     TEXT,
      amount        REAL,
      currency_code TEXT,
      period_unit   TEXT NOT NULL DEFAULT 'month',
      period_count  INTEGER NOT NULL DEFAULT 1,
      next_date     TEXT,
      remind_days   INTEGER NOT NULL DEFAULT 3,
      active        INTEGER NOT NULL DEFAULT 1,
      qr_path       TEXT,
      account_no    TEXT,
      contacts      TEXT,
      note          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at    TEXT
    );
    CREATE INDEX idx_recurring_plans_kind ON recurring_plans(kind, next_date);
    -- Ödeme kayıtları. paid = 1 ödendi (sıradaki tarih ileri alınır: prev_next → new_next), 0 = bekliyor.
    -- record_cash = 1: kasadan düşülür (cash_transaction_id). gift_id: İnfak listesine de yazıldıysa o kayıt.
    CREATE TABLE recurring_payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id             INTEGER NOT NULL,
      date                TEXT NOT NULL,
      amount              REAL,
      currency_code       TEXT,
      paid                INTEGER NOT NULL DEFAULT 1,
      prev_next           TEXT,
      new_next            TEXT,
      record_cash         INTEGER NOT NULL DEFAULT 0,
      add_gift            INTEGER NOT NULL DEFAULT 0,
      cash_transaction_id INTEGER,
      gift_id             INTEGER,
      note                TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at          TEXT
    );
    CREATE INDEX idx_recurring_payments_plan ON recurring_payments(plan_id, date);
    -- Ödemenin dekontları (kamera / galeri / dosya), bir ödemeye birden fazla
    CREATE TABLE recurring_files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id    INTEGER NOT NULL,
      file_path     TEXT NOT NULL,
      original_name TEXT,
      mime_type     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX idx_recurring_files_payment ON recurring_files(payment_id);
  `,
});

migrations.push({
  version: 25,
  name: 'v1.47-son-uyari',
  sql: `
    -- v1.47: Son uyarı (gün + saat, YYYY-MM-DDTHH:MM). O an gelince ödeme hâlâ yapılmadıysa son kez bildirim verilir.
    -- Ödendi işaretlenince sıradaki tarih gibi bir dönem ileri alınır (prev_final → new_final), geri alınınca döner.
    ALTER TABLE recurring_plans ADD COLUMN final_at TEXT;
    ALTER TABLE recurring_payments ADD COLUMN prev_final TEXT;
    ALTER TABLE recurring_payments ADD COLUMN new_final TEXT;
  `,
});

migrations.push({
  version: 26,
  name: 'v1.49-sham-cash',
  sql: `
    -- v1.49: Kasadan çıkan paranın Sham Cash ile kime gönderildiği. Hepsi isteğe bağlı, yalnızca çıkışlarda doldurulur.
    -- sc_account: Sham Cash hesap no / adresi, sc_name: alıcının adı, sc_phone: telefonu, sc_ref: işlem (transfer) numarası,
    -- sc_note: not, sc_qr_path: alıcının QR kodu resmi, sc_qr_text: QR koddan okunan yazı, sc_payee_id: kayıtlı alıcıdan seçildiyse o.
    ALTER TABLE cash_transactions ADD COLUMN sc_account TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_name TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_phone TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_ref TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_note TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_qr_path TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_qr_text TEXT;
    ALTER TABLE cash_transactions ADD COLUMN sc_payee_id INTEGER;
    -- Sık para gönderilen Sham Cash hesapları (listeden seçilir; seçilince bilgiler harekete kopyalanır)
    CREATE TABLE shamcash_payees (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      account_no TEXT,
      phone      TEXT,
      qr_path    TEXT,
      qr_text    TEXT,
      note       TEXT,
      use_count  INTEGER NOT NULL DEFAULT 0,
      last_used  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT
    );
  `,
});
