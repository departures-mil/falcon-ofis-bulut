// İş kuralları: kasa hareketleri, borç, hediye, alış/satış, stok, kâr paylaşımı,
// malzeme ve demirbaş. Her işlem tek bir veritabanı işlemi (transaction) içinde çalışır.

const { COINS, CURRENCIES, kindOf, normalizeAddress, walletTxRowId } = require('./wallets');

const EPS = 1e-9;

class AppError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const now = "datetime('now','localtime')";

function positive(value, code = 'ERR_INVALID_AMOUNT') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new AppError(code);
  return n;
}

function nonNegative(value, code = 'ERR_INVALID_AMOUNT') {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new AppError(code);
  return n;
}

function required(value, code = 'ERR_REQUIRED') {
  const v = typeof value === 'string' ? value.trim() : value;
  if (v === undefined || v === null || v === '') throw new AppError(code);
  return v;
}

const optId = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const optText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const round2 = (n) => Math.round(n * 100) / 100;
// v1.12: kripto paralarda küsurat (BTC, ETH 8 hane; USDT 6 hane)
const CRYPTO_DECIMALS = { BTC: 8, ETH: 8, USDT: 6, USDC: 6, LTC: 8, DOGE: 8, DASH: 8, POL: 8, AVAX: 8, TRX: 6, XRP: 6, TON: 8 };
const roundCur = (n, code) => {
  const d = CRYPTO_DECIMALS[code] ?? 2;
  return Math.round(n * 10 ** d) / 10 ** d;
};
// v1.11: konumların ortak sırası (sıra verilmemiş olanlar ada göre sonda)
const LOCATION_ORDER = 'COALESCE(sort_order, 1000000000), name COLLATE NOCASE';

function createServices(db, { removeFile = () => {} } = {}) {
  const pendingRemovals = [];

  // ---------- Yardımcılar ----------

  function resolvePerson(person) {
    if (!person) return null;
    if (person.id) return Number(person.id);
    const name = optText(person.name);
    if (!name) return null;
    const existing = db.get('SELECT id FROM people WHERE lower(name) = lower(?)', [name]);
    if (existing) return existing.id;
    return db.run('INSERT INTO people (name) VALUES (?)', [name]).lastInsertRowid;
  }

  // v1.42: birden fazla kişi. [{name}|{id}|"ad"] → benzersiz numara listesi (sıra korunur)
  function resolvePeople(list) {
    const ids = [];
    for (const p of Array.isArray(list) ? list : []) {
      const id = resolvePerson(typeof p === 'string' ? { name: p } : p);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  // person (eski tek kişi) ve people (yeni liste) birlikte: ilk kişi person_id, iki ve daha fazlası people_ids
  function peopleCols(person, people) {
    const ids = people !== undefined ? resolvePeople(people) : [resolvePerson(person)].filter(Boolean);
    return { personId: ids[0] ?? null, peopleIds: ids.length > 1 ? JSON.stringify(ids) : null };
  }

  function accountFor(currency) {
    // v1.13: gizlenmiş kutular otomatik kayıtlarda kullanılmaz (o birimde başka kutu yoksa yine de ona yazılır)
    const acc = db.get('SELECT id FROM cash_accounts WHERE currency_code = ? ORDER BY COALESCE(hidden, 0), id LIMIT 1', [currency]);
    if (acc) return acc.id;
    if (!db.get('SELECT code FROM currencies WHERE code = ?', [currency])) throw new AppError('ERR_INVALID_CURRENCY');
    return db.run('INSERT INTO cash_accounts (name, currency_code) VALUES (?, ?)', [`${currency}`, currency]).lastInsertRowid;
  }

  function accountBalance(accountId) {
    return db.get(
      `SELECT a.opening_balance
         + COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id = a.id AND direction = 'in' AND info_only = 0), 0)
         - COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id = a.id AND direction = 'out' AND info_only = 0), 0) AS b
       FROM cash_accounts a WHERE a.id = ?`,
      [accountId],
    )?.b ?? 0;
  }

  // Başka bir modülden gelen kasa hareketini oluşturur veya günceller.
  function upsertLinkedTx(txId, { currency, accountId, direction, amount, date, category, personId, description, relatedType, relatedId }) {
    const account = accountId ?? accountFor(currency);
    if (txId && db.get('SELECT id FROM cash_transactions WHERE id = ?', [txId])) {
      db.run(
        `UPDATE cash_transactions SET account_id=?, direction=?, amount=?, date=?, category=?, person_id=?, description=?,
           related_type=?, related_id=?, updated_at=${now} WHERE id=?`,
        [account, direction, round2(amount), date, category, personId, description, relatedType, relatedId, txId],
      );
      return txId;
    }
    return db.run(
      `INSERT INTO cash_transactions (account_id, direction, amount, date, category, person_id, description, related_type, related_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [account, direction, round2(amount), date, category, personId, description, relatedType, relatedId],
    ).lastInsertRowid;
  }

  function deleteTx(txId) {
    if (!txId) return;
    for (const r of db.all('SELECT file_path FROM receipts WHERE transaction_id = ?', [txId])) pendingRemovals.push(r.file_path);
    db.run('DELETE FROM receipts WHERE transaction_id = ?', [txId]);
    db.run('DELETE FROM cash_transactions WHERE id = ?', [txId]);
  }

  function addReceiptRows(txId, files = []) {
    for (const f of files) {
      db.run('INSERT INTO receipts (transaction_id, file_path, original_name, mime_type) VALUES (?,?,?,?)', [
        txId, required(f.relPath), f.originalName ?? null, f.mime ?? null,
      ]);
    }
  }

  function removeReceiptRows(ids = []) {
    for (const id of ids) {
      const r = db.get('SELECT file_path FROM receipts WHERE id = ?', [id]);
      if (!r) continue;
      pendingRemovals.push(r.file_path);
      db.run('DELETE FROM receipts WHERE id = ?', [id]);
    }
  }

  function productName(id) {
    return db.get('SELECT name FROM products WHERE id = ?', [id])?.name ?? '';
  }

  function stockAt(productId, locationId) {
    return db.get('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?', [productId, locationId])?.quantity ?? 0;
  }

  function changeStock(productId, locationId, delta) {
    if (!locationId) throw new AppError('ERR_LOCATION_REQUIRED');
    const current = stockAt(productId, locationId);
    const next = current + delta;
    if (next < -EPS) throw new AppError('ERR_INSUFFICIENT_STOCK', { available: current });
    db.run(
      `INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?,?,?)
       ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = excluded.quantity`,
      [productId, locationId, Math.max(0, round2(next))],
    );
  }

  function accountCurrency(id) {
    return db.get('SELECT currency_code FROM cash_accounts WHERE id = ?', [id])?.currency_code ?? null;
  }

  function latestRates() {
    const rows = db.all(
      `SELECT currency_code AS code, rate FROM exchange_rates r
       WHERE id = (SELECT MAX(id) FROM exchange_rates WHERE currency_code = r.currency_code)`,
    );
    const map = { USD: 1 };
    for (const r of rows) map[r.code] = r.rate;
    return map;
  }

  function convert(amount, from, to, rates = latestRates()) {
    if (from === to) return amount;
    if (!rates[from] || !rates[to]) return null;
    return (amount / rates[from]) * rates[to];
  }

  // ---------- Kişiler ----------

  const CONTACT_KEYS = ['whatsapp', 'telegram', 'conversations', 'signal', 'phone'];
  function cleanContacts(c) {
    const out = {};
    for (const k of CONTACT_KEYS) if (c && c[k]) out[k] = 1;
    return JSON.stringify(out);
  }

  function savePerson({ id, name, phone, note, contacts }) {
    const n = required(name);
    const dup = db.get('SELECT id FROM people WHERE lower(name) = lower(?) AND id IS NOT ?', [n, id ?? null]);
    if (dup) throw new AppError('ERR_DUPLICATE_NAME');
    if (id) {
      db.run('UPDATE people SET name=?, phone=?, note=? WHERE id=?', [n, optText(phone), optText(note), id]);
      if (contacts !== undefined) db.run('UPDATE people SET contacts=? WHERE id=?', [cleanContacts(contacts), id]);
      return { id };
    }
    return {
      id: db.run('INSERT INTO people (name, phone, note, contacts) VALUES (?,?,?,?)', [n, optText(phone), optText(note), cleanContacts(contacts)]).lastInsertRowid,
    };
  }

  // Kişi listesinde iletişim işaretini aç / kapat
  function togglePersonContact({ id, key }) {
    if (!CONTACT_KEYS.includes(key)) throw new AppError('ERR_REQUIRED');
    const p = db.get('SELECT contacts FROM people WHERE id = ?', [id]);
    if (!p) throw new AppError('ERR_NOT_FOUND');
    let c = {};
    try { c = JSON.parse(p.contacts || '{}') || {}; } catch { c = {}; }
    c[key] = c[key] ? 0 : 1;
    db.run('UPDATE people SET contacts=? WHERE id=?', [cleanContacts(c), id]);
    return { contacts: JSON.parse(cleanContacts(c)) };
  }

  function deletePerson({ id }) {
    const used = db.get(
      `SELECT (SELECT COUNT(*) FROM debts WHERE person_id = :id) + (SELECT COUNT(*) FROM gifts WHERE person_id = :id)
            + (SELECT COUNT(*) FROM sale_profit_shares WHERE person_id = :id) + (SELECT COUNT(*) FROM sales WHERE customer_id = :id)
            + (SELECT COUNT(*) FROM purchases WHERE supplier_id = :id)
            + (SELECT COUNT(*) FROM profit_share_defaults WHERE person_id = :id) AS n`,
      { ':id': id },
    ).n;
    if (used > 0) throw new AppError('ERR_IN_USE');
    // v1.42: çoklu kişi listelerinden de çıkarılır; listenin ilk kişisi silinirse sıradaki ilk kişi olur
    for (const t of db.all(`SELECT id, people_ids FROM cash_transactions WHERE people_ids LIKE '%' || ? || '%'`, [String(id)])) {
      let ids = [];
      try { ids = JSON.parse(t.people_ids) || []; } catch { ids = []; }
      if (!ids.includes(Number(id))) continue;
      ids = ids.filter((x) => x !== Number(id));
      db.run('UPDATE cash_transactions SET person_id=?, people_ids=? WHERE id=?', [ids[0] ?? null, ids.length > 1 ? JSON.stringify(ids) : null, t.id]);
    }
    db.run('UPDATE cash_transactions SET person_id = NULL WHERE person_id = ?', [id]);
    db.run('UPDATE material_movements SET person_id = NULL WHERE person_id = ?', [id]);
    db.run('UPDATE fixed_assets SET assigned_to = NULL WHERE assigned_to = ?', [id]);
    db.run('DELETE FROM people WHERE id = ?', [id]);
    return { ok: true };
  }

  // ---------- Kasa ----------

  // add_to_cash = false: yalnızca bilgi amaçlı kayıt, kasa bakiyesini etkilemez
  function saveCashTx({ id, account_id, direction, amount, date, category, person, people, description, add_to_cash = true, newReceipts = [], removeReceiptIds = [] }) {
    const infoOnly = add_to_cash === false ? 1 : 0;
    const pc = peopleCols(person, people);
    if (id) {
      const old = db.get('SELECT * FROM cash_transactions WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      if (old.related_type) {
        // Başka modülden gelen kayıtta yalnızca açıklama ve dekont değişir
        db.run(`UPDATE cash_transactions SET description=?, updated_at=${now} WHERE id=?`, [optText(description), id]);
        // v1.42: bağlı kayıtta da ek kişiler yazılabilir; ilk kişi (borç / hediye sahibi) değişmez
        if (people !== undefined) {
          const ids = [old.person_id, ...resolvePeople(people).filter((x) => x !== old.person_id)].filter(Boolean);
          db.run('UPDATE cash_transactions SET people_ids=? WHERE id=?', [ids.length > 1 ? JSON.stringify(ids) : null, id]);
        }
      } else {
        if (!['in', 'out'].includes(direction)) throw new AppError('ERR_REQUIRED');
        db.run(
          `UPDATE cash_transactions SET account_id=?, direction=?, amount=?, date=?, category=?, person_id=?, people_ids=?, description=?, info_only=?, updated_at=${now} WHERE id=?`,
          [required(account_id), direction, roundCur(positive(amount), accountCurrency(account_id)), required(date), category || 'other', pc.personId, pc.peopleIds, optText(description), infoOnly, id],
        );
      }
      removeReceiptRows(removeReceiptIds);
      addReceiptRows(id, newReceipts);
      return { id };
    }
    if (!['in', 'out'].includes(direction)) throw new AppError('ERR_REQUIRED');
    const newId = db.run(
      'INSERT INTO cash_transactions (account_id, direction, amount, date, category, person_id, people_ids, description, info_only) VALUES (?,?,?,?,?,?,?,?,?)',
      [required(account_id), direction, roundCur(positive(amount), accountCurrency(account_id)), required(date), category || 'other', pc.personId, pc.peopleIds, optText(description), infoOnly],
    ).lastInsertRowid;
    addReceiptRows(newId, newReceipts);
    return { id: newId };
  }

  function deleteCashTx({ id }) {
    const tx = db.get('SELECT * FROM cash_transactions WHERE id = ?', [id]);
    if (!tx) return { ok: true };
    if (tx.related_type === 'transfer') {
      const pairId = tx.related_id === tx.id ? db.get("SELECT id FROM cash_transactions WHERE related_type='transfer' AND related_id=? AND id<>?", [tx.id, tx.id])?.id : tx.related_id;
      deleteTx(pairId);
      deleteTx(tx.id);
      return { ok: true };
    }
    if (tx.related_type) throw new AppError('ERR_LINKED_TX');
    deleteTx(id);
    return { ok: true };
  }

  // Kasalar arası döviz bozdurma / aktarma
  function transfer({ from_account, to_account, amount_from, amount_to, date, description }) {
    if (Number(from_account) === Number(to_account)) throw new AppError('ERR_SAME_ACCOUNT');
    const a = roundCur(positive(amount_from), accountCurrency(from_account));
    const b = roundCur(positive(amount_to), accountCurrency(to_account));
    const d = required(date);
    const desc = optText(description);
    const outId = db.run(
      `INSERT INTO cash_transactions (account_id, direction, amount, date, category, description, related_type) VALUES (?,?,?,?,?,?, 'transfer')`,
      [required(from_account), 'out', a, d, 'transfer', desc],
    ).lastInsertRowid;
    db.run('UPDATE cash_transactions SET related_id = ? WHERE id = ?', [outId, outId]);
    db.run(
      `INSERT INTO cash_transactions (account_id, direction, amount, date, category, description, related_type, related_id) VALUES (?,?,?,?,?,?, 'transfer', ?)`,
      [required(to_account), 'in', b, d, 'transfer', desc, outId],
    );
    return { id: outId };
  }

  function saveAccount({ id, name, opening_balance }) {
    db.run('UPDATE cash_accounts SET name=?, opening_balance=? WHERE id=?', [required(name), Number(opening_balance) || 0, id]);
    return { id };
  }

  // v1.13: kutuyu gizle / göster (kayıtlar silinmez)
  function setAccountHidden({ id, hidden }) {
    if (!db.get('SELECT id FROM cash_accounts WHERE id = ?', [id])) throw new AppError('ERR_NOT_FOUND');
    db.run('UPDATE cash_accounts SET hidden = ? WHERE id = ?', [hidden ? 1 : 0, id]);
    return { id };
  }

  function addReceipts({ transaction_id, files }) {
    if (!db.get('SELECT id FROM cash_transactions WHERE id = ?', [transaction_id])) throw new AppError('ERR_NOT_FOUND');
    addReceiptRows(transaction_id, files);
    return { ok: true };
  }

  function deleteReceipt({ id }) {
    removeReceiptRows([id]);
    return { ok: true };
  }

  // ---------- Kurlar ----------

  // Elle girişte her para birimi için { buy, sell }; internetten gelen tek değer hem alış hem satış olur.
  // Toplam dolar hesabında kullanılan rate = satış kuru (yoksa alış kuru).
  function saveRates({ rates, source = 'manual' }) {
    const blank = (v) => v === '' || v === null || v === undefined;
    for (const [code, value] of Object.entries(rates || {})) {
      if (code === 'USD' || blank(value)) continue;
      // İnternetten gelen kripto fiyatları yalnızca kullanılan (tabloda olan) para birimleri için yazılır
      if (source === 'online' && !db.get('SELECT code FROM currencies WHERE code = ?', [code])) continue;
      let buy;
      let sell;
      if (typeof value === 'object') {
        buy = blank(value.buy) ? null : positive(value.buy, 'ERR_INVALID_RATE');
        sell = blank(value.sell) ? null : positive(value.sell, 'ERR_INVALID_RATE');
        if (buy === null && sell === null) continue;
      } else {
        buy = sell = positive(value, 'ERR_INVALID_RATE');
      }
      db.run('INSERT INTO exchange_rates (currency_code, rate, buy_rate, sell_rate, source) VALUES (?,?,?,?,?)', [code, sell ?? buy, buy, sell, source]);
    }
    return { rates: latestRates() };
  }

  // ---------- Borç / alacak ----------

  function debtPaid(debtId) {
    return db.get('SELECT COALESCE(SUM(amount),0) AS s FROM debt_payments WHERE debt_id = ?', [debtId]).s;
  }

  function refreshDebtStatus(debtId) {
    const d = db.get('SELECT amount FROM debts WHERE id = ?', [debtId]);
    if (!d) return;
    const status = debtPaid(debtId) >= d.amount - 0.005 ? 'closed' : 'open';
    db.run('UPDATE debts SET status = ? WHERE id = ?', [status, debtId]);
  }

  function saveDebt({ id, person, direction, amount, currency, date, due_date, description, record_cash = true }) {
    if (!['borrowed', 'lent'].includes(direction)) throw new AppError('ERR_REQUIRED');
    const personId = resolvePerson(person);
    if (!personId) throw new AppError('ERR_PERSON_REQUIRED');
    const amt = round2(positive(amount));
    const cur = required(currency);
    const d = required(date);
    let debtId = id;
    if (id) {
      const old = db.get('SELECT * FROM debts WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      if (old.currency_code !== cur && db.get('SELECT COUNT(*) AS n FROM debt_payments WHERE debt_id = ?', [id]).n > 0) throw new AppError('ERR_CURRENCY_LOCKED');
      if (debtPaid(id) > amt + 0.005) throw new AppError('ERR_AMOUNT_BELOW_PAID');
      db.run('UPDATE debts SET person_id=?, direction=?, amount=?, currency_code=?, date=?, due_date=?, description=? WHERE id=?', [
        personId, direction, amt, cur, d, optText(due_date), optText(description), id,
      ]);
    } else {
      debtId = db.run('INSERT INTO debts (person_id, direction, amount, currency_code, date, due_date, description) VALUES (?,?,?,?,?,?,?)', [
        personId, direction, amt, cur, d, optText(due_date), optText(description),
      ]).lastInsertRowid;
    }
    const existingTx = db.get('SELECT cash_transaction_id AS t FROM debts WHERE id = ?', [debtId]).t;
    if (record_cash) {
      const txId = upsertLinkedTx(existingTx, {
        currency: cur, direction: direction === 'borrowed' ? 'in' : 'out', amount: amt, date: d, category: 'debt',
        personId, description: optText(description), relatedType: 'debt', relatedId: debtId,
      });
      db.run('UPDATE debts SET cash_transaction_id = ? WHERE id = ?', [txId, debtId]);
    } else if (existingTx) {
      db.run('UPDATE debts SET cash_transaction_id = NULL WHERE id = ?', [debtId]);
      deleteTx(existingTx);
    }
    refreshDebtStatus(debtId);
    return { id: debtId };
  }

  function addDebtPayment({ debt_id, amount, date, note, record_cash = true }) {
    const debt = db.get('SELECT * FROM debts WHERE id = ?', [debt_id]);
    if (!debt) throw new AppError('ERR_NOT_FOUND');
    const amt = round2(positive(amount));
    const remaining = debt.amount - debtPaid(debt_id);
    if (amt > remaining + 0.005) throw new AppError('ERR_PAYMENT_EXCEEDS', { remaining: round2(remaining) });
    const d = required(date);
    const payId = db.run('INSERT INTO debt_payments (debt_id, amount, date, note) VALUES (?,?,?,?)', [debt_id, amt, d, optText(note)]).lastInsertRowid;
    if (record_cash) {
      const txId = upsertLinkedTx(null, {
        currency: debt.currency_code, direction: debt.direction === 'borrowed' ? 'out' : 'in', amount: amt, date: d,
        category: 'debt', personId: debt.person_id, description: optText(note), relatedType: 'debt_payment', relatedId: payId,
      });
      db.run('UPDATE debt_payments SET cash_transaction_id = ? WHERE id = ?', [txId, payId]);
    }
    refreshDebtStatus(debt_id);
    return { id: payId };
  }

  function deleteDebtPayment({ id }) {
    const p = db.get('SELECT * FROM debt_payments WHERE id = ?', [id]);
    if (!p) return { ok: true };
    db.run('DELETE FROM debt_payments WHERE id = ?', [id]);
    deleteTx(p.cash_transaction_id);
    refreshDebtStatus(p.debt_id);
    return { ok: true };
  }

  function deleteDebt({ id }) {
    const debt = db.get('SELECT * FROM debts WHERE id = ?', [id]);
    if (!debt) return { ok: true };
    for (const p of db.all('SELECT * FROM debt_payments WHERE debt_id = ?', [id])) {
      db.run('DELETE FROM debt_payments WHERE id = ?', [p.id]);
      deleteTx(p.cash_transaction_id);
    }
    db.run('DELETE FROM debts WHERE id = ?', [id]);
    deleteTx(debt.cash_transaction_id);
    return { ok: true };
  }

  // ---------- Hediyeler ----------

  function saveGift({ id, person, amount, currency, date, description, record_cash = true, newReceipts = [] }) {
    const personId = resolvePerson(person);
    if (!personId) throw new AppError('ERR_PERSON_REQUIRED');
    const amt = round2(positive(amount));
    const cur = required(currency);
    const d = required(date);
    let giftId = id;
    if (id) {
      db.run('UPDATE gifts SET person_id=?, amount=?, currency_code=?, date=?, description=? WHERE id=?', [personId, amt, cur, d, optText(description), id]);
    } else {
      giftId = db.run('INSERT INTO gifts (person_id, amount, currency_code, date, description) VALUES (?,?,?,?,?)', [
        personId, amt, cur, d, optText(description),
      ]).lastInsertRowid;
    }
    const existingTx = db.get('SELECT cash_transaction_id AS t FROM gifts WHERE id = ?', [giftId]).t;
    if (record_cash) {
      const txId = upsertLinkedTx(existingTx, {
        currency: cur, direction: 'out', amount: amt, date: d, category: 'gift', personId,
        description: optText(description), relatedType: 'gift', relatedId: giftId,
      });
      db.run('UPDATE gifts SET cash_transaction_id = ? WHERE id = ?', [txId, giftId]);
      addReceiptRows(txId, newReceipts);
    } else if (existingTx) {
      db.run('UPDATE gifts SET cash_transaction_id = NULL WHERE id = ?', [giftId]);
      deleteTx(existingTx);
    }
    return { id: giftId };
  }

  function deleteGift({ id }) {
    const g = db.get('SELECT * FROM gifts WHERE id = ?', [id]);
    if (!g) return { ok: true };
    db.run('DELETE FROM gifts WHERE id = ?', [id]);
    deleteTx(g.cash_transaction_id);
    return { ok: true };
  }

  // ---------- Konumlar ----------

  function saveLocation({ id, name, description }) {
    const n = required(name);
    const dup = db.get('SELECT id FROM locations WHERE lower(name) = lower(?) AND id IS NOT ?', [n, id ?? null]);
    if (dup) throw new AppError('ERR_DUPLICATE_NAME');
    if (id) {
      db.run('UPDATE locations SET name=?, description=? WHERE id=?', [n, optText(description), id]);
      return { id };
    }
    // Yeni konum listenin sonuna eklenir
    const last = db.get('SELECT MAX(sort_order) AS m FROM locations').m;
    return { id: db.run('INSERT INTO locations (name, description, sort_order) VALUES (?,?,?)', [n, optText(description), last ? last + 1 : null]).lastInsertRowid };
  }

  // v1.11: konum sırası (yukarı / aşağı). Önce tüm konumlar mevcut sırayla 1..n numaralanır, sonra yer değiştirilir.
  function moveLocation({ id, step }) {
    const rows = db.all(`SELECT id, sort_order FROM locations ORDER BY ${LOCATION_ORDER}`);
    const i = rows.findIndex((r) => r.id === Number(id));
    if (i < 0) throw new AppError('ERR_NOT_FOUND');
    const j = i + (Number(step) < 0 ? -1 : 1);
    if (j < 0 || j >= rows.length) return { ok: true };
    [rows[i], rows[j]] = [rows[j], rows[i]];
    rows.forEach((r, k) => {
      if (r.sort_order !== k + 1) db.run('UPDATE locations SET sort_order = ? WHERE id = ?', [k + 1, r.id]);
    });
    return { ok: true };
  }

  function deleteLocation({ id }) {
    const used = db.get(
      `SELECT (SELECT COUNT(*) FROM product_stock WHERE location_id = :id AND quantity > 0)
            + (SELECT COUNT(*) FROM materials WHERE location_id = :id)
            + (SELECT COUNT(*) FROM fixed_assets WHERE location_id = :id)
            + (SELECT COUNT(*) FROM purchases WHERE location_id = :id)
            + (SELECT COUNT(*) FROM sales WHERE location_id = :id) AS n`,
      { ':id': id },
    ).n;
    if (used > 0) throw new AppError('ERR_IN_USE');
    db.run('UPDATE material_places SET location_id = NULL WHERE location_id = ?', [id]);
    db.run('DELETE FROM product_stock WHERE location_id = ?', [id]);
    db.run('DELETE FROM locations WHERE id = ?', [id]);
    return { ok: true };
  }

  // ---------- Ürünler ----------

  // Maliyet ve hedef kâr yüzdesi (boş bırakılabilir)
  // Maliyet, para birimi, kâr yüzdesi ve satış fiyatı birbiriyle tutarlı tutulur:
  // satış fiyatı girildiyse (maliyet varsa) kâr yüzdesi ondan, girilmediyse maliyet + yüzdeden hesaplanır.
  function pricingValues({ cost_price, cost_currency, profit_pct, sale_price }, existing = null) {
    const empty = (v) => v === '' || v === null || v === undefined;
    const cost = empty(cost_price) ? null : nonNegative(cost_price);
    let sale = sale_price === undefined ? undefined : empty(sale_price) ? null : nonNegative(sale_price);
    const priced = cost !== null || (sale ?? existing?.sale_price ?? null) !== null;
    const cur = priced ? required(cost_currency || 'USD') : optText(cost_currency);
    if (cur && !db.get('SELECT code FROM currencies WHERE code = ?', [cur])) throw new AppError('ERR_INVALID_CURRENCY');
    let pct = empty(profit_pct) ? null : Number(profit_pct);
    if (pct !== null && !Number.isFinite(pct)) throw new AppError('ERR_INVALID_AMOUNT');
    if (sale === undefined) {
      // Satış fiyatı gönderilmedi (ürün düzenleme penceresi): yüzde varsa fiyat yeniden hesaplanır, yoksa eski fiyat korunur
      sale = cost !== null && pct !== null ? round2(cost * (1 + pct / 100)) : existing?.sale_price ?? null;
      if (pct === null && sale !== null && cost > 0) pct = (sale / cost - 1) * 100;
    } else if (sale !== null && cost > 0) {
      pct = (sale / cost - 1) * 100;
    } else if (sale === null && cost !== null && pct !== null) {
      sale = round2(cost * (1 + pct / 100));
    }
    return [cost, cur, pct, sale];
  }

  function saveProduct({ id, name, code, category, unit, description, condition, newImages = [], removeImageIds = [], primaryImageId, stock, serial, addCodes, removeCodeIds, ...pricing }) {
    const n = required(name);
    const c = optText(code);
    if (c && db.get('SELECT id FROM products WHERE code = ? AND id IS NOT ?', [c, id ?? null])) throw new AppError('ERR_DUPLICATE_CODE');
    const cond = ['new', 'used'].includes(condition) ? condition : null;
    const existing = id ? db.get('SELECT sale_price FROM products WHERE id = ?', [id]) : null;
    const [cost, costCur, pct, sale] = pricingValues(pricing, existing);
    const ser = resolveSerial('product', serial, id);
    let productId = id;
    if (id) {
      db.run(`UPDATE products SET name=?, code=?, category=?, unit=?, description=?, condition=?, cost_price=?, cost_currency=?, profit_pct=?, sale_price=?, updated_at=${now} WHERE id=?`, [
        n, c, optText(category), unit || 'pcs', optText(description), cond, cost, costCur, pct, sale, id,
      ]);
      db.run('UPDATE products SET serial = ? WHERE id = ? AND serial IS NOT ?', [ser, id, ser]);
    } else {
      productId = db.run('INSERT INTO products (name, code, category, unit, description, condition, cost_price, cost_currency, profit_pct, sale_price) VALUES (?,?,?,?,?,?,?,?,?,?)', [
        n, c, optText(category), unit || 'pcs', optText(description), cond, cost, costCur, pct, sale,
      ]).lastInsertRowid;
      db.run('UPDATE products SET serial = ? WHERE id = ?', [ser, productId]);
    }
    applyCodes('product', productId, addCodes, removeCodeIds);
    for (const imgId of removeImageIds) {
      const img = db.get('SELECT file_path FROM product_images WHERE id = ? AND product_id = ?', [imgId, productId]);
      if (!img) continue;
      pendingRemovals.push(img.file_path);
      db.run('DELETE FROM product_images WHERE id = ?', [imgId]);
    }
    const newIds = newImages.map(
      (rel) => db.run('INSERT INTO product_images (product_id, file_path) VALUES (?,?)', [productId, required(rel)]).lastInsertRowid,
    );
    // Ana fotoğraf: seçilen, yoksa ilk fotoğraf
    let primary = primaryImageId;
    if (typeof primary === 'string' && primary.startsWith('new:')) primary = newIds[Number(primary.slice(4))];
    if (!primary || !db.get('SELECT id FROM product_images WHERE id = ? AND product_id = ?', [primary, productId])) {
      primary = db.get('SELECT id FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, id LIMIT 1', [productId])?.id;
    }
    db.run('UPDATE product_images SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE product_id = ?', [primary ?? -1, productId]);

    // Elle stok düzeltme: konum bazında adet
    if (Array.isArray(stock)) {
      for (const s of stock) {
        const q = nonNegative(s.quantity, 'ERR_INVALID_QUANTITY');
        db.run(
          `INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?,?,?)
           ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = excluded.quantity`,
          [productId, required(s.location_id, 'ERR_LOCATION_REQUIRED'), q],
        );
      }
    }
    return { id: productId };
  }

  // Ürün penceresindeki kâr hesabı: yalnızca maliyet, para birimi ve kâr yüzdesi kaydedilir
  function saveProductPricing({ id, ...pricing }) {
    const existing = db.get('SELECT sale_price FROM products WHERE id = ?', [id]);
    if (!existing) throw new AppError('ERR_NOT_FOUND');
    const [cost, cur, pct, sale] = pricingValues(pricing, existing);
    db.run(`UPDATE products SET cost_price=?, cost_currency=?, profit_pct=?, sale_price=?, updated_at=${now} WHERE id=?`, [cost, cur, pct, sale, id]);
    return { id };
  }

  function deleteProduct({ id }) {
    const used = db.get('SELECT (SELECT COUNT(*) FROM purchases WHERE product_id = :id) + (SELECT COUNT(*) FROM sales WHERE product_id = :id) AS n', { ':id': id }).n;
    if (used > 0) throw new AppError('ERR_PRODUCT_HAS_TRADES');
    for (const img of db.all('SELECT file_path FROM product_images WHERE product_id = ?', [id])) pendingRemovals.push(img.file_path);
    deleteCodesOf('product', id);
    db.run('DELETE FROM products WHERE id = ?', [id]);
    return { ok: true };
  }

  // Ortalama alış maliyeti (istenen para biriminde, güncel kurla)
  function productUnitCost({ product_id, currency }) {
    const rates = latestRates();
    let qty = 0;
    let total = 0;
    for (const p of db.all('SELECT quantity, unit_price, currency_code FROM purchases WHERE product_id = ?', [product_id])) {
      const v = convert(p.unit_price, p.currency_code, currency, rates);
      if (v === null) continue;
      qty += p.quantity;
      total += v * p.quantity;
    }
    if (qty > 0) return { unit_cost: round2(total / qty), based_on: qty };
    // Alış kaydı yoksa üründe girilen maliyet kullanılır
    const p = db.get('SELECT cost_price, cost_currency FROM products WHERE id = ?', [product_id]);
    const own = p?.cost_price !== null && p?.cost_price !== undefined ? convert(p.cost_price, p.cost_currency || 'USD', currency, rates) : null;
    return { unit_cost: own !== null ? round2(own) : 0, based_on: 0, from_product: own !== null };
  }

  // Alış / satış görselleri ve dekontları
  function saveTradeFiles(col, tradeId, files = [], removeIds = []) {
    for (const fid of removeIds || []) {
      const f = db.get(`SELECT file_path FROM trade_files WHERE id = ? AND ${col} = ?`, [fid, tradeId]);
      if (!f) continue;
      pendingRemovals.push(f.file_path);
      db.run('DELETE FROM trade_files WHERE id = ?', [fid]);
    }
    for (const f of files || []) {
      db.run(`INSERT INTO trade_files (${col}, kind, file_path, original_name, mime_type) VALUES (?,?,?,?,?)`, [
        tradeId, f.kind === 'receipt' ? 'receipt' : 'image', required(f.relPath), f.originalName ?? null, f.mime ?? null,
      ]);
    }
  }

  function deleteTradeFiles(col, tradeId) {
    for (const f of db.all(`SELECT file_path FROM trade_files WHERE ${col} = ?`, [tradeId])) pendingRemovals.push(f.file_path);
    db.run(`DELETE FROM trade_files WHERE ${col} = ?`, [tradeId]);
  }

  function deleteTradeFile({ id }) {
    const f = db.get('SELECT file_path FROM trade_files WHERE id = ?', [id]);
    if (!f) return { ok: true };
    pendingRemovals.push(f.file_path);
    db.run('DELETE FROM trade_files WHERE id = ?', [id]);
    return { ok: true };
  }

  // ---------- Alışlar ----------

  function savePurchase({ id, product_id, location_id, supplier, date, quantity, unit_price, currency, note, record_cash = true, newFiles = [], removeFileIds = [] }) {
    const pid = required(product_id, 'ERR_PRODUCT_REQUIRED');
    const loc = required(location_id, 'ERR_LOCATION_REQUIRED');
    const qty = positive(quantity, 'ERR_INVALID_QUANTITY');
    const price = nonNegative(unit_price);
    const cur = required(currency);
    const d = required(date);
    const supplierId = resolvePerson(supplier);
    let purchaseId = id;
    if (id) {
      const old = db.get('SELECT * FROM purchases WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      changeStock(old.product_id, old.location_id, -old.quantity);
      db.run(
        `UPDATE purchases SET product_id=?, location_id=?, supplier_id=?, date=?, quantity=?, unit_price=?, currency_code=?, note=?, updated_at=${now} WHERE id=?`,
        [pid, loc, supplierId, d, qty, price, cur, optText(note), id],
      );
    } else {
      purchaseId = db.run(
        'INSERT INTO purchases (product_id, location_id, supplier_id, date, quantity, unit_price, currency_code, note) VALUES (?,?,?,?,?,?,?,?)',
        [pid, loc, supplierId, d, qty, price, cur, optText(note)],
      ).lastInsertRowid;
    }
    changeStock(pid, loc, qty);
    saveTradeFiles('purchase_id', purchaseId, newFiles, removeFileIds);
    const existingTx = db.get('SELECT cash_transaction_id AS t FROM purchases WHERE id = ?', [purchaseId]).t;
    const total = qty * price;
    if (record_cash && total > 0) {
      const txId = upsertLinkedTx(existingTx, {
        currency: cur, direction: 'out', amount: total, date: d, category: 'purchase', personId: supplierId,
        description: `${productName(pid)} × ${qty}`, relatedType: 'purchase', relatedId: purchaseId,
      });
      db.run('UPDATE purchases SET cash_transaction_id = ? WHERE id = ?', [txId, purchaseId]);
    } else if (existingTx) {
      db.run('UPDATE purchases SET cash_transaction_id = NULL WHERE id = ?', [purchaseId]);
      deleteTx(existingTx);
    }
    return { id: purchaseId };
  }

  function deletePurchase({ id }) {
    const p = db.get('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!p) return { ok: true };
    changeStock(p.product_id, p.location_id, -p.quantity);
    deleteTradeFiles('purchase_id', id);
    db.run('DELETE FROM purchases WHERE id = ?', [id]);
    deleteTx(p.cash_transaction_id);
    return { ok: true };
  }

  // ---------- Satışlar ve kâr paylaşımı ----------

  function saveSale({ id, product_id, location_id, customer, date, quantity, unit_price, unit_cost, currency, note, record_cash = true, shares = [], newFiles = [], removeFileIds = [] }) {
    const pid = required(product_id, 'ERR_PRODUCT_REQUIRED');
    const loc = required(location_id, 'ERR_LOCATION_REQUIRED');
    const qty = positive(quantity, 'ERR_INVALID_QUANTITY');
    const price = nonNegative(unit_price);
    const cost = nonNegative(unit_cost);
    const cur = required(currency);
    const d = required(date);
    const customerId = resolvePerson(customer);
    const profit = round2((price - cost) * qty);

    let saleId = id;
    let hasPaidShares = false;
    if (id) {
      const old = db.get('SELECT * FROM sales WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      hasPaidShares = db.get('SELECT COUNT(*) AS n FROM sale_profit_shares WHERE sale_id = ? AND paid = 1', [id]).n > 0;
      if (hasPaidShares && (old.currency_code !== cur || Math.abs(old.profit - profit) > 0.005)) throw new AppError('ERR_SHARES_PAID');
      changeStock(old.product_id, old.location_id, old.quantity);
      db.run(
        `UPDATE sales SET product_id=?, location_id=?, customer_id=?, date=?, quantity=?, unit_price=?, unit_cost=?, currency_code=?, profit=?, note=?, updated_at=${now} WHERE id=?`,
        [pid, loc, customerId, d, qty, price, cost, cur, profit, optText(note), id],
      );
    } else {
      saleId = db.run(
        'INSERT INTO sales (product_id, location_id, customer_id, date, quantity, unit_price, unit_cost, currency_code, profit, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [pid, loc, customerId, d, qty, price, cost, cur, profit, optText(note)],
      ).lastInsertRowid;
    }
    // Satılan adet stoktan düşer
    changeStock(pid, loc, -qty);
    saveTradeFiles('sale_id', saleId, newFiles, removeFileIds);

    if (!hasPaidShares) {
      const clean = (shares || []).filter((s) => s && (s.person?.id || optText(s.person?.name)) && Number(s.percentage) > 0);
      const totalPct = clean.reduce((sum, s) => sum + Number(s.percentage), 0);
      if (totalPct > 100 + EPS) throw new AppError('ERR_SHARES_OVER_100');
      db.run('DELETE FROM sale_profit_shares WHERE sale_id = ?', [saleId]);
      for (const s of clean) {
        const pct = Number(s.percentage);
        if (pct < 0 || pct > 100) throw new AppError('ERR_SHARES_OVER_100');
        db.run('INSERT INTO sale_profit_shares (sale_id, person_id, percentage, amount) VALUES (?,?,?,?)', [
          saleId, resolvePerson(s.person), pct, round2((Math.max(profit, 0) * pct) / 100),
        ]);
      }
    }

    const existingTx = db.get('SELECT cash_transaction_id AS t FROM sales WHERE id = ?', [saleId]).t;
    const total = qty * price;
    if (record_cash && total > 0) {
      const txId = upsertLinkedTx(existingTx, {
        currency: cur, direction: 'in', amount: total, date: d, category: 'sale', personId: customerId,
        description: `${productName(pid)} × ${qty}`, relatedType: 'sale', relatedId: saleId,
      });
      db.run('UPDATE sales SET cash_transaction_id = ? WHERE id = ?', [txId, saleId]);
    } else if (existingTx) {
      db.run('UPDATE sales SET cash_transaction_id = NULL WHERE id = ?', [saleId]);
      deleteTx(existingTx);
    }
    return { id: saleId, profit };
  }

  function deleteSale({ id }) {
    const s = db.get('SELECT * FROM sales WHERE id = ?', [id]);
    if (!s) return { ok: true };
    if (db.get('SELECT COUNT(*) AS n FROM sale_profit_shares WHERE sale_id = ? AND paid = 1', [id]).n > 0) throw new AppError('ERR_SHARES_PAID');
    changeStock(s.product_id, s.location_id, s.quantity);
    deleteTradeFiles('sale_id', id);
    db.run('DELETE FROM sales WHERE id = ?', [id]);
    deleteTx(s.cash_transaction_id);
    return { ok: true };
  }

  function payShare({ id, date, record_cash = true }) {
    const share = db.get(
      'SELECT sh.*, s.currency_code, s.product_id FROM sale_profit_shares sh JOIN sales s ON s.id = sh.sale_id WHERE sh.id = ?',
      [id],
    );
    if (!share) throw new AppError('ERR_NOT_FOUND');
    if (share.paid) return { id };
    const d = date || today();
    let txId = null;
    if (record_cash && share.amount > 0) {
      txId = upsertLinkedTx(null, {
        currency: share.currency_code, direction: 'out', amount: share.amount, date: d, category: 'profit_share',
        personId: share.person_id, description: `${productName(share.product_id)} (%${share.percentage})`,
        relatedType: 'profit_share', relatedId: id,
      });
    }
    db.run('UPDATE sale_profit_shares SET paid = 1, paid_date = ?, cash_transaction_id = ? WHERE id = ?', [d, txId, id]);
    return { id };
  }

  function unpayShare({ id }) {
    const share = db.get('SELECT * FROM sale_profit_shares WHERE id = ?', [id]);
    if (!share) throw new AppError('ERR_NOT_FOUND');
    db.run('UPDATE sale_profit_shares SET paid = 0, paid_date = NULL, cash_transaction_id = NULL WHERE id = ?', [id]);
    deleteTx(share.cash_transaction_id);
    return { id };
  }

  // Varsayılan kâr paylaşımı: bir kez girilir, her yeni satışta otomatik doldurulur
  function saveShareDefaults({ shares = [] }) {
    const clean = (shares || []).filter((s) => s && (s.person?.id || optText(s.person?.name)) && Number(s.percentage) > 0);
    let total = 0;
    const seen = new Set();
    const rows = clean.map((s) => {
      const pct = Number(s.percentage);
      if (!Number.isFinite(pct) || pct > 100) throw new AppError('ERR_SHARES_OVER_100');
      total += pct;
      const personId = resolvePerson(s.person);
      if (seen.has(personId)) throw new AppError('ERR_DUPLICATE_NAME');
      seen.add(personId);
      return [personId, pct];
    });
    if (total > 100 + EPS) throw new AppError('ERR_SHARES_OVER_100');
    db.run('DELETE FROM profit_share_defaults');
    for (const [personId, pct] of rows) db.run('INSERT INTO profit_share_defaults (person_id, percentage) VALUES (?,?)', [personId, pct]);
    return { count: rows.length };
  }

  function shareDefaults() {
    return db.all('SELECT d.person_id, p.name, d.percentage FROM profit_share_defaults d JOIN people p ON p.id = d.person_id ORDER BY d.id');
  }

  // ---------- Malzemeler ----------

  // Malzeme kategorileri: ağaç yapısı (kategori > alt kategori > ...)
  function categoryTree(rootId) {
    const ids = [rootId];
    for (let i = 0; i < ids.length; i++) {
      for (const r of db.all('SELECT id FROM material_categories WHERE parent_id = ?', [ids[i]])) ids.push(r.id);
    }
    return ids;
  }

  function saveMaterialCategory({ id, name, parent_id }) {
    const n = required(name);
    const parent = optId(parent_id);
    if (parent !== null) {
      if (!db.get('SELECT id FROM material_categories WHERE id = ?', [parent])) throw new AppError('ERR_NOT_FOUND');
      if (id && categoryTree(Number(id)).includes(parent)) throw new AppError('ERR_CATEGORY_LOOP');
    }
    if (db.get('SELECT id FROM material_categories WHERE lower(name) = lower(?) AND parent_id IS ? AND id IS NOT ?', [n, parent, id ?? null])) {
      throw new AppError('ERR_DUPLICATE_NAME');
    }
    if (id) {
      if (!db.get('SELECT id FROM material_categories WHERE id = ?', [id])) throw new AppError('ERR_NOT_FOUND');
      db.run('UPDATE material_categories SET name = ?, parent_id = ? WHERE id = ?', [n, parent, id]);
      return { id };
    }
    return { id: db.run('INSERT INTO material_categories (name, parent_id) VALUES (?, ?)', [n, parent]).lastInsertRowid };
  }

  // Kategori silinince içindeki malzemeler üst kategoriye (yoksa kategorisize) taşınır; malzemeler silinmez
  function deleteMaterialCategory({ id }) {
    const cat = db.get('SELECT * FROM material_categories WHERE id = ?', [id]);
    if (!cat) throw new AppError('ERR_NOT_FOUND');
    const ids = categoryTree(cat.id);
    const marks = ids.map(() => '?').join(',');
    db.run(`UPDATE materials SET category_id = ?, updated_at=${now} WHERE category_id IN (${marks})`, [cat.parent_id ?? null, ...ids]);
    for (const cid of ids.slice().reverse()) db.run('DELETE FROM material_categories WHERE id = ?', [cid]);
    return { id };
  }

  function saveMaterial({ id, name, code, unit, min_quantity, location_id, place_id, category_id, note, condition, image, removeImage, initial_quantity, serial, addCodes, removeCodeIds, initial_price, initial_currency, initial_record_cash = false, initial_date, initial_person }) {
    const cat = optId(category_id);
    if (cat !== null && !db.get('SELECT id FROM material_categories WHERE id = ?', [cat])) throw new AppError('ERR_NOT_FOUND');
    const n = required(name);
    const c = optText(code);
    if (c && db.get('SELECT id FROM materials WHERE code = ? AND id IS NOT ?', [c, id ?? null])) throw new AppError('ERR_DUPLICATE_CODE');
    const minQ = nonNegative(min_quantity, 'ERR_INVALID_QUANTITY');
    const cond = ['new', 'used'].includes(condition) ? condition : null;
    const ser = resolveSerial('material', serial, id);
    const plc = optId(place_id);
    if (plc !== null && !db.get('SELECT id FROM material_places WHERE id = ?', [plc])) throw new AppError('ERR_NOT_FOUND');
    let materialId = id;
    if (id) {
      const old = db.get('SELECT image_path FROM materials WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      let img = old.image_path;
      if ((removeImage || image) && old.image_path) {
        pendingRemovals.push(old.image_path);
        img = null;
      }
      if (image) img = image;
      // category_id gönderilmediyse (eski çağrılar) mevcut kategori korunur
      const prev = db.get('SELECT category_id, condition FROM materials WHERE id = ?', [id]);
      const catVal = category_id === undefined ? prev.category_id : cat;
      // durum gönderilmediyse (eski çağrılar) mevcut değer korunur
      const condVal = condition === undefined ? prev.condition : cond;
      db.run(`UPDATE materials SET name=?, code=?, unit=?, min_quantity=?, location_id=?, category_id=?, note=?, condition=?, image_path=?, updated_at=${now} WHERE id=?`, [
        n, c, unit || 'pcs', minQ, optId(location_id), catVal, optText(note), condVal, img, id,
      ]);
      db.run('UPDATE materials SET serial = ? WHERE id = ? AND serial IS NOT ?', [ser, id, ser]);
      // v1.40: yer gönderilmediyse (eski çağrılar) mevcut yer korunur
      if (place_id !== undefined) db.run('UPDATE materials SET place_id = ? WHERE id = ? AND place_id IS NOT ?', [plc, id, plc]);
    } else {
      materialId = db.run('INSERT INTO materials (name, code, unit, min_quantity, location_id, category_id, note, condition, image_path) VALUES (?,?,?,?,?,?,?,?,?)', [
        n, c, unit || 'pcs', minQ, optId(location_id), cat, optText(note), cond, image || null,
      ]).lastInsertRowid;
      db.run('UPDATE materials SET serial = ? WHERE id = ?', [ser, materialId]);
      if (plc !== null) db.run('UPDATE materials SET place_id = ? WHERE id = ?', [plc, materialId]);
      const q = nonNegative(initial_quantity, 'ERR_INVALID_QUANTITY');
      // v1.22: başlangıç adedinin alış fiyatı; kasadan düşülmezse yalnızca bilgi amaçlı kalır
      if (q > 0) {
        addMaterialMovement({
          material_id: materialId, direction: 'in', quantity: q, date: initial_date || today(), note: null,
          unit_price: initial_price, currency: initial_currency || 'USD', person: initial_person, record_cash: !!initial_record_cash,
        });
      }
    }
    applyCodes('material', materialId, addCodes, removeCodeIds);
    return { id: materialId };
  }

  function addMaterialMovement({ material_id, direction, quantity, date, unit_price, currency, person, note, record_cash = false }) {
    const m = db.get('SELECT * FROM materials WHERE id = ?', [material_id]);
    if (!m) throw new AppError('ERR_NOT_FOUND');
    if (!['in', 'out'].includes(direction)) throw new AppError('ERR_REQUIRED');
    const qty = positive(quantity, 'ERR_INVALID_QUANTITY');
    if (direction === 'out' && qty > m.quantity + EPS) throw new AppError('ERR_INSUFFICIENT_STOCK', { available: m.quantity });
    const price = unit_price === '' || unit_price === null || unit_price === undefined ? null : nonNegative(unit_price);
    const cur = price !== null ? required(currency) : null;
    const d = required(date);
    const personId = resolvePerson(person);
    const movId = db.run(
      'INSERT INTO material_movements (material_id, direction, quantity, date, unit_price, currency_code, person_id, note) VALUES (?,?,?,?,?,?,?,?)',
      [material_id, direction, qty, d, price, cur, personId, optText(note)],
    ).lastInsertRowid;
    db.run(`UPDATE materials SET quantity = quantity + ?, updated_at=${now} WHERE id = ?`, [direction === 'in' ? qty : -qty, material_id]);
    if (record_cash && direction === 'in' && price) {
      const txId = upsertLinkedTx(null, {
        currency: cur, direction: 'out', amount: qty * price, date: d, category: 'material', personId,
        description: `${m.name} × ${qty}`, relatedType: 'material', relatedId: movId,
      });
      db.run('UPDATE material_movements SET cash_transaction_id = ? WHERE id = ?', [txId, movId]);
    }
    return { id: movId };
  }

  // v1.22: "Alış ekle" ekranından ürün veya malzeme alışı; listede olmayan ürün / malzeme aynı anda oluşturulur.
  // Malzeme alışı malzemenin giriş hareketi olarak kaydedilir (kasadan düşülmezse bilgi amaçlı).
  function savePurchaseEntry({ kind = 'product', material_id, newItem, ...purchase }) {
    if (kind === 'material') {
      let mid = material_id;
      if (newItem) {
        mid = saveMaterial({
          name: newItem.name, unit: newItem.unit, min_quantity: 0, location_id: purchase.location_id || null, category_id: newItem.category_id ?? null,
          note: newItem.note, condition: newItem.condition, initial_quantity: 0,
        }).id;
      } else if (!db.get('SELECT id FROM materials WHERE id = ?', [mid])) {
        throw new AppError('ERR_PRODUCT_REQUIRED');
      }
      const mov = addMaterialMovement({
        material_id: mid, direction: 'in', quantity: purchase.quantity, date: purchase.date, unit_price: purchase.unit_price,
        currency: purchase.currency, person: purchase.supplier, note: purchase.note, record_cash: !!purchase.record_cash,
      });
      return { id: mov.id, material_id: mid };
    }
    let pid = purchase.product_id;
    if (newItem) pid = saveProduct({ name: newItem.name, category: newItem.category, unit: newItem.unit, condition: newItem.condition }).id;
    return { ...savePurchase({ ...purchase, product_id: pid }), product_id: pid };
  }

  function deleteMaterialMovement({ id }) {
    const mv = db.get('SELECT * FROM material_movements WHERE id = ?', [id]);
    if (!mv) return { ok: true };
    const m = db.get('SELECT quantity FROM materials WHERE id = ?', [mv.material_id]);
    const next = m.quantity + (mv.direction === 'in' ? -mv.quantity : mv.quantity);
    if (next < -EPS) throw new AppError('ERR_INSUFFICIENT_STOCK', { available: m.quantity });
    db.run('UPDATE materials SET quantity = ? WHERE id = ?', [Math.max(0, round2(next)), mv.material_id]);
    db.run('DELETE FROM material_movements WHERE id = ?', [id]);
    deleteTx(mv.cash_transaction_id);
    return { ok: true };
  }

  function deleteMaterial({ id }) {
    const m = db.get('SELECT image_path FROM materials WHERE id = ?', [id]);
    if (!m) return { ok: true };
    for (const mv of db.all('SELECT cash_transaction_id FROM material_movements WHERE material_id = ?', [id])) deleteTx(mv.cash_transaction_id);
    if (m.image_path) pendingRemovals.push(m.image_path);
    deleteCodesOf('material', id);
    db.run('DELETE FROM materials WHERE id = ?', [id]);
    return { ok: true };
  }

  // ---------- Demirbaşlar ----------

  function saveAsset({ id, name, asset_code, category, serial_no, purchase_date, purchase_price, currency, location_id, assigned, status, note, newImages = [], removeImageIds = [], primaryImageId, image, removeImage, record_cash = false, serial, addCodes, removeCodeIds }) {
    const n = required(name);
    const code = optText(asset_code);
    if (code && db.get('SELECT id FROM fixed_assets WHERE asset_code = ? AND id IS NOT ?', [code, id ?? null])) throw new AppError('ERR_DUPLICATE_CODE');
    const price = purchase_price === '' || purchase_price === null || purchase_price === undefined ? null : nonNegative(purchase_price);
    const cur = price !== null ? required(currency) : optText(currency);
    const st = ['active', 'repair', 'retired', 'lost'].includes(status) ? status : 'active';
    const assignedId = resolvePerson(assigned);
    const values = [n, code, optText(category), optText(serial_no), optText(purchase_date), price, cur, optId(location_id), assignedId, st, optText(note)];
    const ser = resolveSerial('asset', serial, id);
    let assetId = id;
    if (id) {
      if (!db.get('SELECT id FROM fixed_assets WHERE id = ?', [id])) throw new AppError('ERR_NOT_FOUND');
      db.run(
        `UPDATE fixed_assets SET name=?, asset_code=?, category=?, serial_no=?, purchase_date=?, purchase_price=?, currency_code=?, location_id=?,
           assigned_to=?, status=?, note=?, updated_at=${now} WHERE id=?`,
        [...values, id],
      );
    } else {
      assetId = db.run(
        `INSERT INTO fixed_assets (name, asset_code, category, serial_no, purchase_date, purchase_price, currency_code, location_id, assigned_to, status, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        values,
      ).lastInsertRowid;
    }
    db.run('UPDATE fixed_assets SET serial = ? WHERE id = ? AND serial IS NOT ?', [ser, assetId, ser]);
    applyCodes('asset', assetId, addCodes, removeCodeIds);

    // Eski sürümden kalan tek fotoğraf listede yoksa önce listeye alınır (kaybolmasın)
    const legacy = db.get('SELECT image_path FROM fixed_assets WHERE id = ?', [assetId]).image_path;
    if (legacy && !db.get('SELECT 1 AS x FROM asset_images WHERE asset_id = ? AND file_path = ?', [assetId, legacy])) {
      db.run('INSERT INTO asset_images (asset_id, file_path, is_primary) VALUES (?,?,1)', [assetId, legacy]);
    }
    // Fotoğraflar (eski tek fotoğraflı çağrı da desteklenir)
    const removeIds = [...(removeImageIds || [])];
    const adds = [...(newImages || [])];
    if (removeImage || image) for (const r of db.all('SELECT id FROM asset_images WHERE asset_id = ?', [assetId])) removeIds.push(r.id);
    if (image) adds.push(image);
    for (const imgId of removeIds) {
      const img = db.get('SELECT file_path FROM asset_images WHERE id = ? AND asset_id = ?', [imgId, assetId]);
      if (!img) continue;
      pendingRemovals.push(img.file_path);
      db.run('DELETE FROM asset_images WHERE id = ?', [imgId]);
    }
    const newIds = adds.map((rel) => db.run('INSERT INTO asset_images (asset_id, file_path) VALUES (?,?)', [assetId, required(rel)]).lastInsertRowid);
    let primary = primaryImageId;
    if (typeof primary === 'string' && primary.startsWith('new:')) primary = newIds[Number(primary.slice(4))];
    if (!primary || !db.get('SELECT id FROM asset_images WHERE id = ? AND asset_id = ?', [primary, assetId])) {
      primary = db.get('SELECT id FROM asset_images WHERE asset_id = ? ORDER BY is_primary DESC, id LIMIT 1', [assetId])?.id;
    }
    db.run('UPDATE asset_images SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE asset_id = ?', [primary ?? -1, assetId]);
    // Ana fotoğraf listede gösterilmek için demirbaş kaydında da tutulur
    const primaryPath = primary ? db.get('SELECT file_path FROM asset_images WHERE id = ?', [primary]).file_path : null;
    if (legacy !== primaryPath) db.run('UPDATE fixed_assets SET image_path = ? WHERE id = ?', [primaryPath, assetId]);

    const existingTx = db.get('SELECT cash_transaction_id AS t FROM fixed_assets WHERE id = ?', [assetId]).t;
    if (record_cash && price) {
      const txId = upsertLinkedTx(existingTx, {
        currency: cur, direction: 'out', amount: price, date: optText(purchase_date) || today(), category: 'asset', personId: null,
        description: n, relatedType: 'asset', relatedId: assetId,
      });
      db.run('UPDATE fixed_assets SET cash_transaction_id = ? WHERE id = ?', [txId, assetId]);
    } else if (existingTx) {
      db.run('UPDATE fixed_assets SET cash_transaction_id = NULL WHERE id = ?', [assetId]);
      deleteTx(existingTx);
    }
    return { id: assetId };
  }

  function deleteAsset({ id }) {
    const a = db.get('SELECT * FROM fixed_assets WHERE id = ?', [id]);
    if (!a) return { ok: true };
    const paths = new Set(db.all('SELECT file_path FROM asset_images WHERE asset_id = ?', [id]).map((r) => r.file_path));
    if (a.image_path) paths.add(a.image_path);
    for (const rel of paths) pendingRemovals.push(rel);
    db.run('DELETE FROM asset_images WHERE asset_id = ?', [id]);
    deleteCodesOf('asset', id);
    db.run('DELETE FROM fixed_assets WHERE id = ?', [id]);
    deleteTx(a.cash_transaction_id);
    return { ok: true };
  }

  // ---------- v1.33: Ürün <-> Demirbaş aktarma ----------
  // Fotoğraflar kopyalanmaz, aynı dosyayı gösterir; dosya başka kayıt kullandığı sürece silinmez (call içinde bakılır).

  // Ürünün bir konumdaki parçası (adet kadar) demirbaş olur, ürün stoğundan düşülür.
  // delete_product: stok kalmadıysa ve alış/satış kaydı yoksa ürün kaydı kaldırılır (fotoğraf ve kodlar demirbaşa geçer).
  function transferProductToAsset({ product_id, location_id, quantity = 1, delete_product = false }) {
    const p = db.get('SELECT * FROM products WHERE id = ?', [product_id]);
    if (!p) throw new AppError('ERR_NOT_FOUND');
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new AppError('ERR_INVALID_QUANTITY');
    const hasStock = db.get('SELECT COALESCE(SUM(quantity), 0) AS n FROM product_stock WHERE product_id = ?', [product_id]).n > 0;
    const loc = optId(location_id);
    if (hasStock) {
      if (!loc) throw new AppError('ERR_LOCATION_REQUIRED');
      const here = db.get('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?', [product_id, loc])?.quantity || 0;
      if (qty > here) throw new AppError('ERR_INSUFFICIENT_STOCK');
      db.run('UPDATE product_stock SET quantity = quantity - ? WHERE product_id = ? AND location_id = ?', [qty, product_id, loc]);
    }
    // Değer: üründe girilen maliyet, yoksa alışların ortalaması (dolar)
    let price = p.cost_price ?? null;
    let cur = price !== null ? p.cost_currency || 'USD' : null;
    if (price === null) {
      const avg = productUnitCost({ product_id, currency: 'USD' });
      if (avg.based_on > 0) { price = avg.unit_cost; cur = 'USD'; }
    }
    const images = db.all('SELECT file_path, is_primary FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, id', [product_id]);
    const note = `${p.serial || p.name} ürününden aktarıldı`;
    const ids = [];
    for (let i = 0; i < qty; i++) {
      const assetId = db.run(
        `INSERT INTO fixed_assets (name, category, purchase_date, purchase_price, currency_code, location_id, status, note, image_path) VALUES (?,?,?,?,?,?,?,?,?)`,
        [p.name, p.category, today(), price, cur, loc, 'active', note, images[0]?.file_path ?? null],
      ).lastInsertRowid;
      db.run('UPDATE fixed_assets SET serial = ? WHERE id = ?', [nextSerial('asset'), assetId]);
      images.forEach((img, k) => db.run('INSERT INTO asset_images (asset_id, file_path, is_primary) VALUES (?,?,?)', [assetId, img.file_path, k === 0 ? 1 : 0]));
      ids.push(assetId);
    }
    let deleted = false;
    if (delete_product) {
      const left = db.get('SELECT COALESCE(SUM(quantity), 0) AS n FROM product_stock WHERE product_id = ?', [product_id]).n;
      const trades = db.get('SELECT (SELECT COUNT(*) FROM purchases WHERE product_id = :id) + (SELECT COUNT(*) FROM sales WHERE product_id = :id) AS n', { ':id': product_id }).n;
      if (left <= 0 && trades === 0) {
        db.run("UPDATE item_codes SET item_type = 'asset', item_id = ? WHERE item_type = 'product' AND item_id = ?", [ids[0], product_id]);
        db.run('DELETE FROM product_images WHERE product_id = ?', [product_id]);
        db.run('DELETE FROM product_stock WHERE product_id = ?', [product_id]);
        db.run('DELETE FROM products WHERE id = ?', [product_id]);
        deleted = true;
      }
    }
    return { ids, deleted };
  }

  // Demirbaş ürünlere geçer: yeni ürün (adı, kategorisi, fotoğrafları, değeri maliyet olarak) ya da seçilen ürüne 1 adet eklenir.
  // Demirbaş listeden kalkar; alınırken kasaya yazılan çıkış kaydı silinmez, kasada normal kayıt olarak kalır.
  function transferAssetToProduct({ asset_id, product_id, location_id }) {
    const a = db.get('SELECT * FROM fixed_assets WHERE id = ?', [asset_id]);
    if (!a) throw new AppError('ERR_NOT_FOUND');
    const loc = optId(location_id) ?? a.location_id;
    if (!loc) throw new AppError('ERR_LOCATION_REQUIRED');
    const images = db.all('SELECT file_path FROM asset_images WHERE asset_id = ? ORDER BY is_primary DESC, id', [asset_id]).map((r) => r.file_path);
    if (a.image_path && !images.includes(a.image_path)) images.unshift(a.image_path);
    let pid = optId(product_id);
    if (pid) {
      if (!db.get('SELECT id FROM products WHERE id = ?', [pid])) throw new AppError('ERR_NOT_FOUND');
    } else {
      pid = db.run('INSERT INTO products (name, category, unit, condition, cost_price, cost_currency, description) VALUES (?,?,?,?,?,?,?)', [
        a.name, a.category, 'pcs', 'used', a.purchase_price ?? null, a.purchase_price !== null && a.purchase_price !== undefined ? a.currency_code || 'USD' : null,
        a.note || null,
      ]).lastInsertRowid;
      db.run('UPDATE products SET serial = ? WHERE id = ?', [nextSerial('product'), pid]);
      images.forEach((rel, k) => db.run('INSERT INTO product_images (product_id, file_path, is_primary) VALUES (?,?,?)', [pid, rel, k === 0 ? 1 : 0]));
    }
    db.run(
      `INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?,?,1)
       ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = quantity + 1`,
      [pid, loc],
    );
    db.run("UPDATE item_codes SET item_type = 'product', item_id = ? WHERE item_type = 'asset' AND item_id = ?", [pid, asset_id]);
    if (a.cash_transaction_id) db.run('UPDATE cash_transactions SET related_type = NULL, related_id = NULL WHERE id = ?', [a.cash_transaction_id]);
    db.run('DELETE FROM asset_images WHERE asset_id = ?', [asset_id]);
    db.run('DELETE FROM fixed_assets WHERE id = ?', [asset_id]);
    return { product_id: pid };
  }

  // ---------- v1.14: QR seri numarası ve barkodlar ----------
  // Seri no: U-00001 (ürün), M-00001 (malzeme), D-00001 (demirbaş). Etiketteki QR kod bu numarayı taşır.
  const SERIAL = { product: ['products', 'U'], material: ['materials', 'M'], asset: ['fixed_assets', 'D'] };

  function nextSerial(type) {
    const [tbl, prefix] = SERIAL[type];
    const max = db.get(`SELECT MAX(CAST(substr(serial, 3) AS INTEGER)) AS n FROM ${tbl} WHERE serial GLOB '${prefix}-[0-9]*'`)?.n || 0;
    return `${prefix}-${String(max + 1).padStart(5, '0')}`;
  }

  // Formdan gelen seri no; boşsa mevcut numara korunur, o da yoksa sıradaki numara verilir
  function resolveSerial(type, value, id) {
    const [tbl] = SERIAL[type];
    let s = optText(value);
    if (s && s.length > 64) throw new AppError('ERR_INVALID_CODE');
    if (!s && id) s = db.get(`SELECT serial FROM ${tbl} WHERE id = ?`, [id])?.serial || null;
    if (!s) return nextSerial(type);
    if (db.get(`SELECT id FROM ${tbl} WHERE lower(serial) = lower(?) AND id IS NOT ?`, [s, id ?? null])) throw new AppError('ERR_DUPLICATE_SERIAL');
    return s;
  }

  // Seri numarası olmayan kayıtlara (ör. eski sürümlü cihazdan gelen) numara verir
  function ensureSerials() {
    let changed = 0;
    for (const type of Object.keys(SERIAL)) {
      const [tbl] = SERIAL[type];
      for (const r of db.all(`SELECT id FROM ${tbl} WHERE serial IS NULL OR trim(serial) = '' ORDER BY id`)) {
        db.run(`UPDATE ${tbl} SET serial = ? WHERE id = ?`, [nextSerial(type), r.id]);
        changed++;
      }
    }
    return { changed };
  }

  function itemExists(type, id) {
    if (!SERIAL[type]) throw new AppError('ERR_NOT_FOUND');
    return !!db.get(`SELECT id FROM ${SERIAL[type][0]} WHERE id = ?`, [id]);
  }

  // Kayda hazır barkod / QR kodu ekler (aynı kod aynı kayıtta ikinci kez eklenmez)
  function addCodeRow(type, itemId, { code, format, image_path } = {}) {
    const v = String(code ?? '').trim();
    if (!v) throw new AppError('ERR_CODE_REQUIRED');
    if (v.length > 2000) throw new AppError('ERR_INVALID_CODE');
    const same = db.get('SELECT id, image_path FROM item_codes WHERE item_type = ? AND item_id = ? AND code = ?', [type, itemId, v]);
    if (same) {
      if (!same.image_path && optText(image_path)) db.run('UPDATE item_codes SET image_path = ? WHERE id = ?', [optText(image_path), same.id]);
      return same.id;
    }
    return db.run('INSERT INTO item_codes (item_type, item_id, code, format, image_path) VALUES (?,?,?,?,?)', [type, itemId, v, optText(format), optText(image_path)]).lastInsertRowid;
  }

  function applyCodes(type, itemId, add, remove) {
    for (const cid of remove || []) {
      const c = db.get('SELECT image_path FROM item_codes WHERE id = ? AND item_type = ? AND item_id = ?', [cid, type, itemId]);
      if (!c) continue;
      if (c.image_path) pendingRemovals.push(c.image_path);
      db.run('DELETE FROM item_codes WHERE id = ?', [cid]);
    }
    for (const c of add || []) addCodeRow(type, itemId, c);
  }

  function deleteCodesOf(type, itemId) {
    for (const c of db.all('SELECT image_path FROM item_codes WHERE item_type = ? AND item_id = ?', [type, itemId])) if (c.image_path) pendingRemovals.push(c.image_path);
    db.run('DELETE FROM item_codes WHERE item_type = ? AND item_id = ?', [type, itemId]);
  }

  // Okutulan ama kayıtlı olmayan kodu mevcut bir kayda bağlar
  function addItemCode({ item_type, item_id, code, format, image_path }) {
    if (!itemExists(item_type, item_id)) throw new AppError('ERR_NOT_FOUND');
    return { id: addCodeRow(item_type, Number(item_id), { code, format, image_path }) };
  }

  function deleteItemCode({ id }) {
    const c = db.get('SELECT image_path FROM item_codes WHERE id = ?', [id]);
    if (!c) return { ok: true };
    if (c.image_path) pendingRemovals.push(c.image_path);
    db.run('DELETE FROM item_codes WHERE id = ?', [id]);
    return { ok: true };
  }


  // ---------- v1.17: Kasa kategorileri (ekle, adını değiştir, sil, sırala); v1.18: alt kategori ----------

  // Aktarım (kasalar arası) seçilemez; "Diğer" her zaman kalır (yeni hareketin varsayılanı)
  const FIXED_CATEGORIES = ['transfer', 'other'];
  const CATEGORY_ORDER = 'sort_order, id';
  const sameParent = (pid) => (pid ? ['parent_id = ?', [pid]] : ['parent_id IS NULL', []]);

  // Üst kategori yalnızca görünür, üst seviyedeki bir kategori olabilir (tek seviye)
  function categoryParent(parent_id, selfId) {
    const pid = Number(parent_id) || null;
    if (!pid) return null;
    const p = db.get('SELECT * FROM cash_categories WHERE id = ?', [pid]);
    if (!p || p.hidden || p.parent_id || p.key === 'transfer' || pid === Number(selfId)) throw new AppError('ERR_CATEGORY_PARENT');
    if (selfId && db.get('SELECT id FROM cash_categories WHERE parent_id = ? AND hidden = 0', [selfId])) throw new AppError('ERR_CATEGORY_PARENT');
    return pid;
  }

  function saveCashCategory({ id, name, parent_id }) {
    const n = required(name, 'ERR_REQUIRED').slice(0, 60);
    const self = id ? db.get('SELECT * FROM cash_categories WHERE id = ?', [id]) : null;
    if (id && !self) throw new AppError('ERR_NOT_FOUND');
    if (self?.key === 'transfer' && parent_id) throw new AppError('ERR_CATEGORY_PARENT');
    const pid = parent_id === undefined && self ? self.parent_id : categoryParent(parent_id, id);
    const [where, wp] = sameParent(pid);
    const dup = db.get(`SELECT id FROM cash_categories WHERE hidden = 0 AND ${where} AND lower(trim(name)) = lower(?) AND id <> ?`, [...wp, n, Number(id) || 0]);
    if (dup) throw new AppError('ERR_CATEGORY_EXISTS');
    const max = db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cash_categories').m;
    if (self) {
      const moved = (self.parent_id || null) !== pid;
      db.run('UPDATE cash_categories SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?', [n, pid, moved ? max + 1 : self.sort_order, id]);
      return { id: self.id, key: self.key };
    }
    // Aynı yerde aynı adla silinmiş bir kategori varsa geri getirilir (eski hareketleri de onunla birleşir)
    const old = db.get(`SELECT id, key FROM cash_categories WHERE hidden = 1 AND ${where} AND lower(trim(name)) = lower(?)`, [...wp, n]);
    if (old) {
      db.run('UPDATE cash_categories SET hidden = 0, sort_order = ? WHERE id = ?', [max + 1, old.id]);
      return { id: old.id, key: old.key };
    }
    const key = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const newId = db.run('INSERT INTO cash_categories (key, name, sort_order, parent_id) VALUES (?,?,?,?)', [key, n, max + 1, pid]).lastInsertRowid;
    return { id: newId, key };
  }

  // Silme = gizleme: listeden ve seçimden kalkar, eski hareketler adıyla görünmeye devam eder.
  // Alt kategorileri silinmez, üst seviyeye çıkar.
  function deleteCashCategory({ id }) {
    const c = db.get('SELECT * FROM cash_categories WHERE id = ?', [id]);
    if (!c) return { ok: true };
    if (FIXED_CATEGORIES.includes(c.key)) throw new AppError('ERR_CATEGORY_FIXED');
    const max = db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cash_categories').m;
    db.all('SELECT id FROM cash_categories WHERE parent_id = ? ORDER BY sort_order, id', [id]).forEach((ch, i) => {
      db.run('UPDATE cash_categories SET parent_id = NULL, sort_order = ? WHERE id = ?', [max + 1 + i, ch.id]);
    });
    db.run('UPDATE cash_categories SET hidden = 1 WHERE id = ?', [id]);
    return { ok: true };
  }

  function restoreCashCategory({ id }) {
    const c = db.get('SELECT * FROM cash_categories WHERE id = ?', [id]);
    if (!c) throw new AppError('ERR_NOT_FOUND');
    // üst kategorisi silinmişse üst seviyeye geri gelir
    const parent = c.parent_id ? db.get('SELECT * FROM cash_categories WHERE id = ?', [c.parent_id]) : null;
    const pid = parent && !parent.hidden && !parent.parent_id ? parent.id : null;
    const [where, wp] = sameParent(pid);
    if (c.name && db.get(`SELECT id FROM cash_categories WHERE hidden = 0 AND ${where} AND lower(trim(name)) = lower(?) AND id <> ?`, [...wp, c.name.trim(), id])) {
      throw new AppError('ERR_CATEGORY_EXISTS');
    }
    db.run('UPDATE cash_categories SET hidden = 0, parent_id = ? WHERE id = ?', [pid, id]);
    return { id };
  }

  // Aynı üst kategorideki kardeşler arasında bir basamak yukarı / aşağı
  function moveCashCategory({ id, step }) {
    const c = db.get('SELECT * FROM cash_categories WHERE id = ?', [id]);
    if (!c) throw new AppError('ERR_NOT_FOUND');
    const [where, wp] = sameParent(c.parent_id);
    const rows = db.all(`SELECT id, sort_order FROM cash_categories WHERE hidden = 0 AND key <> 'transfer' AND ${where} ORDER BY ${CATEGORY_ORDER}`, wp);
    const i = rows.findIndex((r) => r.id === Number(id));
    const j = i + (Number(step) < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= rows.length) return { ok: true };
    const [a, b] = [rows[i], rows[j]];
    // Yalnızca iki kategorinin sırası değişir; diğerleri yerinde kalır
    const all = db.all(`SELECT id, sort_order FROM cash_categories ORDER BY ${CATEGORY_ORDER}`);
    const ia = all.findIndex((r) => r.id === a.id);
    const ib = all.findIndex((r) => r.id === b.id);
    [all[ia], all[ib]] = [all[ib], all[ia]];
    all.forEach((r, k) => {
      if (r.sort_order !== k + 1) db.run('UPDATE cash_categories SET sort_order = ? WHERE id = ?', [k + 1, r.id]);
    });
    return { ok: true };
  }

  // ---------- v1.15: Kripto cüzdan takibi (yalnızca okuma) ----------

  // v1.38: kind = cüzdan türü (USDT, USDT_ERC20, USDT_TRC20, BTC, ETH); eski kayıtlarda network boş → coin'in varsayılan ağı
  function listWallets() {
    return db.all(
      `SELECT w.*, s.state, s.last_check, s.last_error, s.source,
         (SELECT COUNT(*) FROM crypto_wallet_tx x WHERE x.coin = w.coin AND x.address = w.address AND COALESCE(x.network, '') = COALESCE(w.network, '')) AS tx_count
       FROM crypto_wallets w LEFT JOIN local_wallet_state s ON s.wallet_id = w.id ORDER BY w.coin, w.network, w.id`,
    ).map((w) => {
      const kind = kindOf(w.coin, w.network);
      return { ...w, kind, kind_label: COINS[kind]?.label || w.coin, account_id: COINS[kind]?.account ?? null };
    });
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  // v1.43: türün para birimi ve kasa kutusu yoksa oluşturulur (sabit numara: iki cihazda aynı kayıt, eşitlemede çift olmaz)
  function ensureWalletAccount(kind) {
    const def = COINS[kind];
    if (!def) return;
    const cur = CURRENCIES[def.coin];
    if (cur && !db.get('SELECT code FROM currencies WHERE code = ?', [def.coin])) {
      db.run('INSERT OR IGNORE INTO currencies (code, name, symbol, sort_order) VALUES (?, ?, ?, ?)', [def.coin, cur.name, cur.symbol, cur.sort]);
    }
    if (!db.get('SELECT id FROM cash_accounts WHERE id = ?', [def.account])) {
      db.run("INSERT OR IGNORE INTO cash_accounts (id, name, currency_code, kind) VALUES (?, ?, ?, 'box')", [def.account, def.label, def.coin]);
    }
  }

  // opening_amount: cüzdandaki mevcut bakiye; verilirse kasaya bir kez giriş olarak yazılır
  // coin: cüzdan türü (kind): wallets.js COINS anahtarı (USDT, USDT_ERC20, LTC, USDC_BASE …)
  function saveWallet({ coin: kind, address, label, opening_amount }) {
    const def = COINS[kind];
    if (!def) throw new AppError('ERR_WALLET_COIN');
    let addr;
    try {
      addr = normalizeAddress(kind, address);
    } catch (err) {
      throw new AppError(err.message);
    }
    const dup = db.all('SELECT id, network FROM crypto_wallets WHERE coin = ? AND address = ?', [def.coin, addr])
      .some((w) => kindOf(w.coin || def.coin, w.network) === kind);
    if (dup) throw new AppError('ERR_WALLET_EXISTS');
    ensureWalletAccount(kind);
    // Gizlenmiş kutuya yeni cüzdan bağlanırsa kutu yeniden görünür
    db.run('UPDATE cash_accounts SET hidden = 0 WHERE id = ? AND hidden = 1', [def.account]);
    const id = db.run('INSERT INTO crypto_wallets (coin, network, address, label, watch_from) VALUES (?,?,?,?,?)', [
      def.coin, def.network, addr, optText(label), new Date().toISOString(),
    ]).lastInsertRowid;
    const opening = roundCur(Number(String(opening_amount ?? '').replace(',', '.')) || 0, def.coin);
    if (opening < 0) throw new AppError('ERR_INVALID_AMOUNT');
    if (opening > 0) {
      db.run("INSERT INTO cash_transactions (account_id, direction, amount, date, category, description) VALUES (?, 'in', ?, ?, 'crypto_in', ?)", [
        def.account, opening, localDate(new Date()), `${optText(label) ? `${optText(label)} · ` : ''}Cüzdandaki mevcut bakiye (${def.label})`,
      ]);
    }
    return { id, address: addr, kind };
  }

  // Adres izlemeden çıkarılır; daha önce işlenen kasa kayıtları silinmez
  function deleteWallet({ id }) {
    db.run('DELETE FROM crypto_wallets WHERE id = ?', [id]);
    db.run('DELETE FROM local_wallet_state WHERE wallet_id = ?', [id]);
    return { ok: true };
  }

  // Bulunan hareketleri kasaya yazar (her işlem bir kez): gelen = giriş, giden = çıkış (ağ ücreti dahil).
  // Bu cihazın kontrol durumu da saklanır.
  function recordWalletTx({ wallet_id, items = [], state = {}, source = null, error = null }) {
    const w = db.get('SELECT * FROM crypto_wallets WHERE id = ?', [wallet_id]);
    if (!w) return { added: [] };
    const since = Date.parse(w.watch_from) / 1000;
    const kind = kindOf(w.coin, w.network);
    const coin = COINS[kind];
    if (!coin) return { added: [] };
    if (items.length) ensureWalletAccount(kind);
    const added = [];
    for (const it of items) {
      const time = Number(it.time);
      const direction = it.direction === 'out' ? 'out' : 'in';
      const fee = roundCur(Math.max(0, Number(it.fee) || 0), w.coin);
      const amount = roundCur(Math.max(0, Number(it.amount) || 0) + (direction === 'out' ? fee : 0), w.coin);
      if (!it.key || !it.hash || !(amount > 0) || !(time >= since) || (it.coin !== kind && it.coin !== w.coin) || it.address !== w.address) continue;
      if (db.get('SELECT 1 AS x FROM crypto_wallet_tx WHERE txid = ?', [it.key])) continue;
      const category = direction === 'in' ? 'crypto_in' : 'crypto_out';
      let cashId = walletTxRowId(it.key, time);
      for (let i = 0; i < 5; i++) {
        const other = db.get('SELECT account_id, amount, category FROM cash_transactions WHERE id = ?', [cashId]);
        if (!other) break;
        // Diğer cihaz aynı hareketi zaten eklemiş (eşitleme ile geldi)
        if (other.category === category && other.account_id === coin.account && Math.abs(other.amount - amount) < 1e-9) break;
        cashId++;
      }
      const when = new Date(time * 1000);
      const shortHash = it.hash.length > 16 ? `${it.hash.slice(0, 10)}…${it.hash.slice(-6)}` : it.hash;
      const what = direction === 'in' ? `Cüzdana gelen ${coin.label}` : `Cüzdandan giden ${coin.label}${fee > 0 ? ` (ağ ücreti ${fee} dahil)` : ''}`;
      const desc = `${w.label ? `${w.label} · ` : ''}${what} · tx ${shortHash}`;
      if (!db.get('SELECT 1 AS x FROM cash_transactions WHERE id = ?', [cashId])) {
        db.run('INSERT INTO cash_transactions (id, account_id, direction, amount, date, category, description) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          cashId, coin.account, direction, amount, localDate(when), category, desc,
        ]);
      }
      db.run('INSERT INTO crypto_wallet_tx (txid, coin, network, address, tx_hash, direction, amount, fee, tx_time, cash_tx_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [
        it.key, w.coin, w.network, w.address, it.hash, direction, amount, fee, when.toISOString(), cashId,
      ]);
      added.push({ coin: w.coin, kind, label: coin.label, wallet_label: w.label || null, address: w.address, direction, amount, fee, hash: it.hash, date: localDate(when), cash_tx_id: cashId });
    }
    db.run(
      `INSERT INTO local_wallet_state (wallet_id, state, last_check, last_error, source) VALUES (?,?,?,?,?)
       ON CONFLICT(wallet_id) DO UPDATE SET state = excluded.state, last_check = excluded.last_check, last_error = excluded.last_error,
         source = COALESCE(excluded.source, local_wallet_state.source)`,
      [wallet_id, JSON.stringify(state || {}), new Date().toISOString(), error, source],
    );
    return { added };
  }

  // v1.45: 19 Kas'ta geç görünen 3,8 USDT (ERC20) girişi elle de girilmişti ("VPN Hizmeti") → çift kayıt.
  // Otomatik kayıt kalır, elle girilenin kategorisini alır; elle girilen silinir. İkisi de varsa bir kez çalışır.
  const KNOWN_DUPLICATES = [{ auto: 59396855081745, manual: 59397777983000 }];
  function fixKnownDuplicates() {
    let fixed = 0;
    for (const { auto, manual } of KNOWN_DUPLICATES) {
      const a = db.get('SELECT * FROM cash_transactions WHERE id = ?', [auto]);
      const m = db.get('SELECT * FROM cash_transactions WHERE id = ?', [manual]);
      if (!a || !m || a.account_id !== m.account_id || a.direction !== m.direction || Math.abs(a.amount - m.amount) > 1e-9 || m.related_type) continue;
      db.tx(() => {
        const desc = [optText(m.description), a.description].filter(Boolean).join(' · ');
        db.run('UPDATE cash_transactions SET category = ?, description = ?, person_id = COALESCE(person_id, ?), people_ids = COALESCE(people_ids, ?) WHERE id = ?', [m.category, desc, m.person_id ?? null, m.people_ids ?? null, auto]);
        db.run('UPDATE receipts SET transaction_id = ? WHERE transaction_id = ?', [auto, manual]);
        db.run('DELETE FROM cash_transactions WHERE id = ?', [manual]);
      });
      fixed++;
    }
    return { fixed };
  }

  function recentWalletTx({ limit = 10 } = {}) {
    return db.all('SELECT * FROM crypto_wallet_tx ORDER BY tx_time DESC LIMIT ?', [Math.min(100, Number(limit) || 10)]);
  }

  // ---------- v1.44: cüzdanlar arası swap / exchange ----------
  // Swap = bir cüzdandan çıkan para ile başka bir cüzdana (ya da kasaya) giren paranın eşleşmesi.
  // İki kayıt "Kasalar arası aktarım" olur (gelir/gider toplamlarına girmez); açıklama "Swap · A → B" ile başlar.
  const SWAP_IGNORE_KEY = 'wallet_swap_ignore';
  const SWAP_PREFIX_RE = /^Swap · [^·]*→[^·]*(?: · |$)/;
  const walletBoxes = () => [...new Set(Object.values(COINS).map((c) => c.account))];
  const fmtNum = (n, code) => String(roundCur(Number(n) || 0, code));

  function swapIgnoreList() {
    try {
      const v = JSON.parse(db.get('SELECT value FROM settings WHERE key = ?', [SWAP_IGNORE_KEY])?.value || '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }
  function setSwapIgnore(add = [], remove = []) {
    const rm = new Set(remove.map(String));
    const list = [...new Set([...swapIgnoreList().filter((x) => !rm.has(x)), ...add.map(String)])].slice(-300);
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [SWAP_IGNORE_KEY, JSON.stringify(list)]);
  }

  const cashRow = (id) => db.get(
    `SELECT c.*, a.name AS acc_name, a.currency_code AS cur,
       (SELECT x.tx_time FROM crypto_wallet_tx x WHERE x.cash_tx_id = c.id LIMIT 1) AS tx_time,
       (SELECT x.txid FROM crypto_wallet_tx x WHERE x.cash_tx_id = c.id LIMIT 1) AS wallet_txid
     FROM cash_transactions c JOIN cash_accounts a ON a.id = c.account_id WHERE c.id = ?`, [id]);

  const swapLabel = (o, i) => `Swap · ${fmtNum(o.amount, o.cur)} ${o.acc_name} → ${fmtNum(i.amount, i.cur)} ${i.acc_name}`;
  const stripSwap = (d) => (d ? d.replace(SWAP_PREFIX_RE, '') : d) || null;

  // İki kasa kaydını swap çifti yapar (çıkan kayıt related_id = kendisi, giren kayıt related_id = çıkan; transfer ile aynı biçim)
  function pairSwap(outId, inId) {
    const o = cashRow(outId);
    const i = cashRow(inId);
    if (!o || !i || o.direction !== 'out' || i.direction !== 'in' || o.account_id === i.account_id) throw new AppError('ERR_SWAP_PAIR');
    const label = swapLabel(o, i);
    const desc = (r) => { const rest = stripSwap(r.description); return rest ? `${label} · ${rest}` : label; };
    db.run("UPDATE cash_transactions SET category = 'transfer', related_type = 'transfer', related_id = ?, description = ?, updated_at = datetime('now','localtime') WHERE id = ?", [o.id, desc(o), o.id]);
    db.run("UPDATE cash_transactions SET category = 'transfer', related_type = 'transfer', related_id = ?, description = ?, updated_at = datetime('now','localtime') WHERE id = ?", [o.id, desc(i), i.id]);
    return { id: o.id, from: { account_id: o.account_id, name: o.acc_name, code: o.cur, amount: o.amount }, to: { account_id: i.account_id, name: i.acc_name, code: i.cur, amount: i.amount } };
  }

  // Değer oranı: girenin dolar karşılığı / çıkanın dolar karşılığı (güncel kurla)
  function swapRatio(o, i, rates) {
    if (!rates[o.cur] || !rates[i.cur]) return null;
    const vo = o.amount / rates[o.cur];
    const vi = i.amount / rates[i.cur];
    return vo > 0 ? vi / vo : null;
  }

  // Cüzdandan çıkan bir hareketten sonra (en fazla 6 saat) başka bir cüzdana yakın değerde giriş geldiyse swap sayılır.
  // Aynı para (ör. USDT TRC20 → USDT BEP20): giren, çıkanın %90–100'ü; farklı para: %85–106 (kur farkı + swap ücreti).
  function detectWalletSwaps({ days = 30 } = {}) {
    const ignore = new Set(swapIgnoreList());
    const since = localDate(new Date(Date.now() - (Number(days) || 30) * 86400e3));
    const rows = db.all(
      `SELECT c.id, c.account_id, c.direction, c.amount, a.currency_code AS cur, x.tx_time
       FROM cash_transactions c JOIN crypto_wallet_tx x ON x.cash_tx_id = c.id JOIN cash_accounts a ON a.id = c.account_id
       WHERE c.category IN ('crypto_in', 'crypto_out') AND c.related_type IS NULL AND c.date >= ?`, [since],
    ).filter((r) => !ignore.has(String(r.id)));
    const rates = latestRates();
    const outs = rows.filter((r) => r.direction === 'out');
    const ins = rows.filter((r) => r.direction === 'in');
    const cands = [];
    for (const o of outs) {
      const to = Date.parse(o.tx_time);
      for (const i of ins) {
        if (i.account_id === o.account_id) continue;
        const mins = (Date.parse(i.tx_time) - to) / 60000;
        if (!(mins >= -10 && mins <= 360)) continue;
        const ratio = swapRatio(o, i, rates);
        if (ratio === null) continue;
        const same = o.cur === i.cur;
        if (ratio > (same ? 1.0005 : 1.06) || ratio < (same ? 0.9 : 0.85)) continue;
        cands.push({ o, i, score: Math.abs(1 - ratio) * 100 + Math.max(0, mins) / 60 });
      }
    }
    cands.sort((a, b) => a.score - b.score);
    const used = new Set();
    const swaps = [];
    for (const c of cands) {
      if (used.has(c.o.id) || used.has(c.i.id)) continue;
      used.add(c.o.id);
      used.add(c.i.id);
      swaps.push(pairSwap(c.o.id, c.i.id));
    }
    return { swaps };
  }

  // Elle swap: cüzdandan çıkan kayıt + (bulunan bir giriş ya da elle yazılan kasa / tutar)
  function markWalletSwap({ out_id, in_id, to_account, amount_to, date }) {
    const o = cashRow(required(out_id));
    if (!o || o.direction !== 'out' || !['crypto_out', 'transfer'].includes(o.category)) throw new AppError('ERR_SWAP_PAIR');
    if (o.related_type === 'transfer') unpairWalletSwap({ id: o.id, keep: true });
    let inId = optId(in_id);
    if (inId) {
      const i = cashRow(inId);
      if (!i || i.direction !== 'in' || i.related_type) throw new AppError('ERR_SWAP_PAIR');
    } else {
      const acc = Number(required(to_account));
      if (acc === o.account_id) throw new AppError('ERR_SAME_ACCOUNT');
      const amt = roundCur(positive(amount_to), accountCurrency(acc));
      inId = db.run(
        "INSERT INTO cash_transactions (account_id, direction, amount, date, category, description, related_type) VALUES (?, 'in', ?, ?, 'transfer', NULL, 'transfer')",
        [acc, amt, optText(date) || o.date],
      ).lastInsertRowid;
    }
    setSwapIgnore([], [o.id, inId]);
    return pairSwap(o.id, inId);
  }

  // Swap'ı çözer: cüzdan hareketleri yeniden gelir/gider olur; elle eklenen giriş silinir. Bir daha kendiliğinden eşleşmez.
  function unpairWalletSwap({ id, keep = false }) {
    const t = db.get('SELECT * FROM cash_transactions WHERE id = ?', [id]);
    if (!t || t.related_type !== 'transfer') return { ok: true };
    const outId = t.related_id === t.id ? t.id : t.related_id;
    const pair = db.all("SELECT * FROM cash_transactions WHERE related_type = 'transfer' AND (id = ? OR related_id = ?)", [outId, outId]);
    if (!pair.some((r) => SWAP_PREFIX_RE.test(r.description || ''))) throw new AppError('ERR_SWAP_PAIR');
    const back = [];
    for (const r of pair) {
      const linked = db.get('SELECT 1 AS x FROM crypto_wallet_tx WHERE cash_tx_id = ?', [r.id]);
      if (linked) {
        db.run("UPDATE cash_transactions SET category = ?, related_type = NULL, related_id = NULL, description = ?, updated_at = datetime('now','localtime') WHERE id = ?", [
          r.direction === 'in' ? 'crypto_in' : 'crypto_out', stripSwap(r.description), r.id,
        ]);
        back.push(r.id);
      } else {
        deleteTx(r.id);
      }
    }
    if (!keep) setSwapIgnore(back);
    return { ok: true };
  }

  function listWalletSwaps({ limit = 50 } = {}) {
    const boxes = walletBoxes().join(',');
    const rates = latestRates();
    return db.all(
      `SELECT o.id, o.date, o.description, o.account_id AS from_account, o.amount AS amount_from, fa.currency_code AS from_code, fa.name AS from_name,
         i.id AS in_id, i.account_id AS to_account, i.amount AS amount_to, ta.currency_code AS to_code, ta.name AS to_name,
         (SELECT x.tx_time FROM crypto_wallet_tx x WHERE x.cash_tx_id = o.id LIMIT 1) AS out_time,
         (SELECT x.tx_time FROM crypto_wallet_tx x WHERE x.cash_tx_id = i.id LIMIT 1) AS in_time,
         (SELECT x.tx_hash FROM crypto_wallet_tx x WHERE x.cash_tx_id = o.id LIMIT 1) AS out_hash,
         (SELECT x.tx_hash FROM crypto_wallet_tx x WHERE x.cash_tx_id = i.id LIMIT 1) AS in_hash
       FROM cash_transactions o
       JOIN cash_transactions i ON i.related_type = 'transfer' AND i.related_id = o.id AND i.id <> o.id
       JOIN cash_accounts fa ON fa.id = o.account_id JOIN cash_accounts ta ON ta.id = i.account_id
       WHERE o.related_type = 'transfer' AND o.related_id = o.id
         AND (o.description LIKE 'Swap · %' OR o.account_id IN (${boxes}) OR i.account_id IN (${boxes}))
       ORDER BY COALESCE(out_time, o.date || 'T23:59') DESC, o.id DESC LIMIT ?`,
      [Math.min(500, Number(limit) || 50)],
    ).map((r) => ({
      ...r,
      is_swap: SWAP_PREFIX_RE.test(r.description || ''),
      usd: rates[r.from_code] ? r.amount_from / rates[r.from_code] : null,
      rate: r.amount_from > 0 ? r.amount_to / r.amount_from : null,
    }));
  }

  // Elle swap penceresi için: eşleşebilecek girişler (çıkıştan 1 gün önce – 3 gün sonra) ve hedef kasalar
  function swapCandidates({ out_id }) {
    const o = cashRow(out_id);
    if (!o) return { candidates: [], accounts: [] };
    const rates = latestRates();
    const t = Date.parse(o.tx_time || `${o.date}T12:00:00`);
    const candidates = db.all(
      `SELECT c.id, c.account_id, c.amount, c.date, a.name, a.currency_code AS code, x.tx_time
       FROM cash_transactions c JOIN cash_accounts a ON a.id = c.account_id LEFT JOIN crypto_wallet_tx x ON x.cash_tx_id = c.id
       WHERE c.direction = 'in' AND c.related_type IS NULL AND c.account_id <> ? AND c.date BETWEEN ? AND ?`,
      [o.account_id, localDate(new Date(t - 86400e3)), localDate(new Date(t + 3 * 86400e3))],
    ).map((r) => {
      const ratio = swapRatio(o, { cur: r.code, amount: r.amount }, rates);
      const mins = r.tx_time ? (Date.parse(r.tx_time) - t) / 60000 : null;
      return { ...r, ratio, score: (ratio === null ? 50 : Math.abs(1 - ratio) * 100) + (mins === null ? 24 : Math.abs(mins) / 60) };
    }).filter((r) => r.ratio === null || (r.ratio > 0.5 && r.ratio < 1.5)).sort((a, b) => a.score - b.score).slice(0, 8);
    const boxes = new Set(walletBoxes());
    const accounts = db.all('SELECT id, name, currency_code AS code FROM cash_accounts WHERE hidden = 0 AND id <> ? ORDER BY id', [o.account_id])
      .sort((a, b) => (boxes.has(b.id) - boxes.has(a.id)) || a.id - b.id);
    return {
      out: { id: o.id, amount: o.amount, code: o.cur, name: o.acc_name, date: o.date, tx_time: o.tx_time },
      usd: rates[o.cur] ? o.amount / rates[o.cur] : null, rates, candidates, accounts,
    };
  }

  // ---------- v1.23: ofis interneti (aylık hatırlatma, ödeme, iletişim) ----------

  // Ay ekleme: ayın son günlerinde taşma olmaz (31 Ocak + 1 ay = 28/29 Şubat)
  function addMonths(dateStr, months) {
    const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0, 10);
  }
  const reach = (v) => (v === null || v === undefined || v === '' ? null : v === true || Number(v) === 1 ? 1 : 0);

  function saveInternet({ id, provider, speed, price, currency, paid_until, remind_days, phone, whatsapp, whatsapp_ok, telegram, telegram_ok, contact_note, note, qr, removeQr }) {
    const p = required(provider);
    const pr = price === '' || price === null || price === undefined ? null : nonNegative(price);
    const cur = pr !== null ? required(currency) : (optText(currency) || null);
    const days = Math.max(0, Math.min(60, Math.round(Number(remind_days ?? 3)) || 0));
    const until = optText(paid_until);
    const vals = [p, optText(speed), pr, cur, until, days, optText(phone), optText(whatsapp), optText(telegram), optText(contact_note), optText(note)];
    if (id) {
      const old = db.get('SELECT * FROM internet_services WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      let img = old.qr_path;
      if ((removeQr || qr) && old.qr_path) {
        pendingRemovals.push(old.qr_path);
        img = null;
      }
      if (qr) img = qr;
      db.run(`UPDATE internet_services SET provider=?, speed=?, price=?, currency_code=?, paid_until=?, remind_days=?, phone=?, whatsapp=?, telegram=?, contact_note=?, note=?, qr_path=?, updated_at=${now} WHERE id=?`, [...vals, img, id]);
    } else {
      id = db.run('INSERT INTO internet_services (provider, speed, price, currency_code, paid_until, remind_days, phone, whatsapp, telegram, contact_note, note, qr_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [...vals, qr || null]).lastInsertRowid;
    }
    // Çalışma göstergesi yalnızca değiştiyse güncellenir (ne zaman denendiği de yazılır)
    if (whatsapp_ok !== undefined) setInternetReach({ id, channel: 'whatsapp', ok: whatsapp_ok });
    if (telegram_ok !== undefined) setInternetReach({ id, channel: 'telegram', ok: telegram_ok });
    return { id };
  }

  function setInternetReach({ id, channel, ok }) {
    if (!['whatsapp', 'telegram'].includes(channel)) throw new AppError('ERR_REQUIRED');
    const row = db.get(`SELECT ${channel}_ok AS v FROM internet_services WHERE id = ?`, [id]);
    if (!row) throw new AppError('ERR_NOT_FOUND');
    const v = reach(ok);
    if (row.v === v) return { ok: true };
    db.run(`UPDATE internet_services SET ${channel}_ok = ?, ${channel}_checked = ${now}, updated_at=${now} WHERE id = ?`, [v, id]);
    return { ok: true };
  }

  // Ödeme: süre ay ay uzar (bitmeden ödenirse bitiş gününden, bittikten sonra ödenirse ödeme gününden itibaren)
  function payInternet({ service_id, date, months = 1, amount, currency, record_cash = true, note }) {
    const s = db.get('SELECT * FROM internet_services WHERE id = ?', [service_id]);
    if (!s) throw new AppError('ERR_NOT_FOUND');
    const d = required(date);
    const n = Math.round(positive(months, 'ERR_INVALID_QUANTITY'));
    const amt = amount === '' || amount === null || amount === undefined ? null : nonNegative(amount);
    const cur = amt !== null ? required(currency) : null;
    const from = s.paid_until && s.paid_until >= d ? s.paid_until : d;
    const until = addMonths(from, n);
    const payId = db.run('INSERT INTO internet_payments (service_id, date, months, amount, currency_code, prev_until, new_until, note) VALUES (?,?,?,?,?,?,?,?)', [
      service_id, d, n, amt, cur, s.paid_until, until, optText(note),
    ]).lastInsertRowid;
    db.run(`UPDATE internet_services SET paid_until = ?, updated_at=${now} WHERE id = ?`, [until, service_id]);
    if (record_cash && amt) {
      const txId = upsertLinkedTx(null, {
        currency: cur, direction: 'out', amount: amt, date: d, category: 'bill', personId: null,
        description: `${s.provider} · ${n > 1 ? `${n} ay` : '1 ay'}`, relatedType: 'internet', relatedId: payId,
      });
      db.run('UPDATE internet_payments SET cash_transaction_id = ? WHERE id = ?', [txId, payId]);
    }
    return { id: payId, paid_until: until };
  }

  // Ödeme silinince kasa kaydı da silinir; son ödemeyse bitiş tarihi önceki haline döner
  function deleteInternetPayment({ id }) {
    const p = db.get('SELECT * FROM internet_payments WHERE id = ?', [id]);
    if (!p) return { ok: true };
    const s = db.get('SELECT paid_until FROM internet_services WHERE id = ?', [p.service_id]);
    if (s && s.paid_until === p.new_until) db.run(`UPDATE internet_services SET paid_until = ?, updated_at=${now} WHERE id = ?`, [p.prev_until, p.service_id]);
    db.run('DELETE FROM internet_payments WHERE id = ?', [id]);
    deleteTx(p.cash_transaction_id);
    return { ok: true };
  }

  // Bağlantı silinir; ödemelerin kasa kayıtları kasada kalır (para gerçekten çıktı)
  function deleteInternet({ id }) {
    const s = db.get('SELECT qr_path FROM internet_services WHERE id = ?', [id]);
    if (!s) return { ok: true };
    if (s.qr_path) pendingRemovals.push(s.qr_path);
    db.run('UPDATE cash_transactions SET related_type = NULL, related_id = NULL WHERE related_type = ? AND related_id IN (SELECT id FROM internet_payments WHERE service_id = ?)', ['internet', id]);
    db.run('DELETE FROM internet_payments WHERE service_id = ?', [id]);
    db.run('DELETE FROM internet_services WHERE id = ?', [id]);
    return { ok: true };
  }

  // ---------- v1.26: elektrik sayacı (fotoğraf, numara, okunan değerler) ----------

  function replaceFile(oldRel, next, remove) {
    let rel = oldRel;
    if ((remove || next) && oldRel) {
      pendingRemovals.push(oldRel);
      rel = null;
    }
    return next || rel;
  }

  function saveMeter({ id, name, meter_no, note, photo, removePhoto }) {
    const n = required(name);
    if (id) {
      const old = db.get('SELECT photo_path FROM electricity_meters WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      db.run(`UPDATE electricity_meters SET name=?, meter_no=?, note=?, photo_path=?, updated_at=${now} WHERE id=?`, [
        n, optText(meter_no), optText(note), replaceFile(old.photo_path, photo, removePhoto), id,
      ]);
      return { id };
    }
    return { id: db.run('INSERT INTO electricity_meters (name, meter_no, note, photo_path) VALUES (?,?,?,?)', [n, optText(meter_no), optText(note), photo || null]).lastInsertRowid };
  }

  function deleteMeter({ id }) {
    const m = db.get('SELECT photo_path FROM electricity_meters WHERE id = ?', [id]);
    if (!m) return { ok: true };
    if (m.photo_path) pendingRemovals.push(m.photo_path);
    for (const r of db.all('SELECT photo_path FROM electricity_readings WHERE meter_id = ? AND photo_path IS NOT NULL', [id])) pendingRemovals.push(r.photo_path);
    db.run('DELETE FROM electricity_readings WHERE meter_id = ?', [id]);
    db.run('DELETE FROM electricity_meters WHERE id = ?', [id]);
    return { ok: true };
  }

  function saveReading({ id, meter_id, date, reading, note, photo, removePhoto }) {
    if (!db.get('SELECT id FROM electricity_meters WHERE id = ?', [meter_id])) throw new AppError('ERR_NOT_FOUND');
    const d = required(date);
    const v = nonNegative(reading, 'ERR_INVALID_QUANTITY');
    if (id) {
      const old = db.get('SELECT photo_path FROM electricity_readings WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      db.run('UPDATE electricity_readings SET date=?, reading=?, note=?, photo_path=? WHERE id=?', [d, v, optText(note), replaceFile(old.photo_path, photo, removePhoto), id]);
      return { id };
    }
    return { id: db.run('INSERT INTO electricity_readings (meter_id, date, reading, note, photo_path) VALUES (?,?,?,?,?)', [meter_id, d, v, optText(note), photo || null]).lastInsertRowid };
  }

  function deleteReading({ id }) {
    const r = db.get('SELECT photo_path FROM electricity_readings WHERE id = ?', [id]);
    if (!r) return { ok: true };
    if (r.photo_path) pendingRemovals.push(r.photo_path);
    db.run('DELETE FROM electricity_readings WHERE id = ?', [id]);
    return { ok: true };
  }

  // ---------- v1.40: malzeme yerleri (dolap > kat gibi) ----------

  function placeTree(rootId) {
    const ids = [Number(rootId)];
    for (let i = 0; i < ids.length; i++) {
      for (const r of db.all('SELECT id FROM material_places WHERE parent_id = ?', [ids[i]])) if (!ids.includes(r.id)) ids.push(r.id);
    }
    return ids;
  }

  function saveMaterialPlace({ id, name, parent_id, location_id }) {
    const n = required(name);
    const parent = optId(parent_id);
    if (parent !== null) {
      if (!db.get('SELECT id FROM material_places WHERE id = ?', [parent])) throw new AppError('ERR_NOT_FOUND');
      if (id && placeTree(id).includes(parent)) throw new AppError('ERR_NOT_FOUND');
    }
    const loc = parent === null ? optId(location_id) : null;
    if (loc !== null && !db.get('SELECT id FROM locations WHERE id = ?', [loc])) throw new AppError('ERR_NOT_FOUND');
    // Aynı yerde aynı adla ikinci yer olmaz (Türkçe büyük/küçük harf farkı gözetilmez)
    const key = (x) => String(x).trim().toLocaleLowerCase('tr');
    const sibs = db.all('SELECT id, name FROM material_places WHERE parent_id IS ? AND (? IS NOT NULL OR location_id IS ?) AND id IS NOT ?', [parent, parent, loc, id ?? null]);
    if (sibs.some((r) => key(r.name) === key(n))) throw new AppError('ERR_DUPLICATE_NAME');
    if (id) {
      const old = db.get('SELECT parent_id FROM material_places WHERE id = ?', [id]);
      if (!old) throw new AppError('ERR_NOT_FOUND');
      if ((old.parent_id ?? null) !== parent) {
        const last = db.get('SELECT MAX(sort_order) AS m FROM material_places WHERE parent_id IS ?', [parent]).m;
        db.run('UPDATE material_places SET sort_order = ? WHERE id = ?', [(last || 0) + 1, id]);
      }
      db.run(`UPDATE material_places SET name=?, parent_id=?, location_id=?, updated_at=${now} WHERE id=?`, [n, parent, loc, id]);
      return { id };
    }
    const last = db.get('SELECT MAX(sort_order) AS m FROM material_places WHERE parent_id IS ?', [parent]).m;
    return { id: db.run(`INSERT INTO material_places (name, parent_id, location_id, sort_order, updated_at) VALUES (?,?,?,?,${now})`, [n, parent, loc, (last || 0) + 1]).lastInsertRowid };
  }

  // Aynı üst yerin altındaki yerlerin sırası (yukarı / aşağı)
  function moveMaterialPlace({ id, step }) {
    const p = db.get('SELECT parent_id FROM material_places WHERE id = ?', [id]);
    if (!p) throw new AppError('ERR_NOT_FOUND');
    const rows = db.all('SELECT id, sort_order FROM material_places WHERE parent_id IS ? ORDER BY COALESCE(sort_order, 1000000000), name COLLATE NOCASE', [p.parent_id ?? null]);
    const i = rows.findIndex((r) => r.id === Number(id));
    const j = i + (Number(step) < 0 ? -1 : 1);
    if (j < 0 || j >= rows.length) return { ok: true };
    [rows[i], rows[j]] = [rows[j], rows[i]];
    rows.forEach((r, k) => {
      if (r.sort_order !== k + 1) db.run(`UPDATE material_places SET sort_order = ?, updated_at=${now} WHERE id = ?`, [k + 1, r.id]);
    });
    return { ok: true };
  }

  // Yer silinince alt yerleri de silinir; içindeki malzemeler üst yere (yoksa yersiz) taşınır, malzemeler silinmez
  function deleteMaterialPlace({ id }) {
    const p = db.get('SELECT * FROM material_places WHERE id = ?', [id]);
    if (!p) throw new AppError('ERR_NOT_FOUND');
    const ids = placeTree(p.id);
    const marks = ids.map(() => '?').join(',');
    db.run(`UPDATE materials SET place_id = ?, updated_at=${now} WHERE place_id IN (${marks})`, [p.parent_id ?? null, ...ids]);
    for (const pid of ids.slice().reverse()) db.run('DELETE FROM material_places WHERE id = ?', [pid]);
    return { id };
  }

  // ---------- v1.39: dahili not defteri ----------

  function saveNote({ id, title, body, color }) {
    const t = optText(title);
    const b = typeof body === 'string' && body.trim() ? body.replace(/\s+$/, '') : null;
    if (!t && !b) throw new AppError('ERR_REQUIRED');
    const c = optText(color);
    if (id) {
      if (!db.get('SELECT id FROM notes WHERE id = ?', [id])) throw new AppError('ERR_NOT_FOUND');
      db.run(`UPDATE notes SET title=?, body=?, color=?, updated_at=${now} WHERE id=?`, [t, b, c, id]);
      return { id };
    }
    return { id: db.run(`INSERT INTO notes (title, body, color, updated_at) VALUES (?,?,?,${now})`, [t, b, c]).lastInsertRowid };
  }

  function pinNote({ id, pinned }) {
    db.run('UPDATE notes SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
    return { ok: true };
  }

  function deleteNote({ id }) {
    db.run('DELETE FROM notes WHERE id = ?', [id]);
    return { ok: true };
  }

  const writes = {
    savePerson, deletePerson, togglePersonContact,
    saveCashTx, deleteCashTx, transfer, saveAccount, setAccountHidden, addReceipts, deleteReceipt,
    saveRates,
    saveDebt, addDebtPayment, deleteDebtPayment, deleteDebt,
    saveGift, deleteGift,
    saveLocation, deleteLocation, moveLocation,
    saveProduct, saveProductPricing, deleteProduct,
    savePurchase, savePurchaseEntry, deletePurchase, deleteTradeFile,
    saveSale, deleteSale, payShare, unpayShare, saveShareDefaults,
    saveMaterial, saveMaterialCategory, deleteMaterialCategory, addMaterialMovement, deleteMaterialMovement, deleteMaterial,
    saveAsset, deleteAsset, transferProductToAsset, transferAssetToProduct,
    ensureSerials, addItemCode, deleteItemCode,
    saveWallet, deleteWallet, recordWalletTx, fixKnownDuplicates, detectWalletSwaps, markWalletSwap, unpairWalletSwap,
    saveCashCategory, deleteCashCategory, restoreCashCategory, moveCashCategory,
    saveInternet, setInternetReach, payInternet, deleteInternetPayment, deleteInternet,
    saveMeter, deleteMeter, saveReading, deleteReading,
    saveNote, pinNote, deleteNote,
    saveMaterialPlace, moveMaterialPlace, deleteMaterialPlace,
  };
  const reads = { nextSerial: ({ type }) => ({ serial: SERIAL[type] ? nextSerial(type) : null }), productUnitCost, accountBalance: ({ id }) => ({ balance: accountBalance(id) }), latestRates: () => latestRates(), shareDefaults, listWallets, recentWalletTx, listWalletSwaps, swapCandidates };

  const FILE_REFS = [['receipts', 'file_path'], ['product_images', 'file_path'], ['materials', 'image_path'], ['fixed_assets', 'image_path'], ['asset_images', 'file_path'],
    ['trade_files', 'file_path'], ['item_codes', 'image_path'], ['internet_services', 'qr_path'], ['electricity_meters', 'photo_path'], ['electricity_readings', 'photo_path']];
  function fileInUse(rel) {
    return FILE_REFS.some(([t, c]) => {
      try { return !!db.get(`SELECT 1 AS x FROM ${t} WHERE ${c} = ? LIMIT 1`, [rel]); } catch { return false; }
    });
  }

  // Tek giriş noktası: yazma işlemleri transaction içinde çalışır, silinen dosyalar işlem başarılı olunca kaldırılır.
  function call(name, payload = {}) {
    if (reads[name]) return reads[name](payload);
    const fn = writes[name];
    if (!fn) throw new AppError('ERR_UNKNOWN_ACTION');
    pendingRemovals.length = 0;
    const result = db.tx(() => fn(payload));
    for (const rel of pendingRemovals.splice(0)) {
      // v1.33: aynı dosyayı başka kayıt (ör. aktarılan ürün / demirbaş) hâlâ kullanıyorsa silinmez
      if (fileInUse(rel)) continue;
      try {
        removeFile(rel);
      } catch {
        // dosya zaten yoksa sorun değil
      }
    }
    return result;
  }

  return { call, ...writes, ...reads };
}

module.exports = { createServices, AppError };
