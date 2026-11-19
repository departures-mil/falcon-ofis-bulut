// v1.15: kripto cüzdan takibi (yalnızca okuma). v1.38: USDT ERC20 (Ethereum) ve TRC20 (Tron) eklendi.
// v1.42: aranabilir tam liste: LTC, DOGE, DASH, TRX, XRP, TON, POL, AVAX, Arbitrum / Base / Optimism ETH, USDT ve USDC'nin ağları.
// SafePal gibi cüzdanların herkese açık "Al / Receive" adresleri girilir; bu adreslerin hareketleri açık blokzincir gezginlerinden
// (hesap / anahtar gerektirmeyen) okunur. Gelen ödemeler kasaya otomatik eklenir; bu adreslerden GİDEN ödemeler (ağ ücreti dahil)
// kasadan düşülür. Gizli kelimeler (seed) ve özel anahtar asla istenmez, girilirse reddedilir.
// Masaüstü ve telefon aynı kodu kullanır; ağ isteği fetchFn(url, opts) -> { ok, status, text() } ile yapılır.

const ID_EPOCH = 1735689600;

// Cüzdan türleri. Anahtar (kind) arayüzde seçilen değerdir; coin = kasadaki para birimi, network = ağ.
// Her türün kendi kasa kutusu vardır (sabit numara: her cihazda aynı, eşitlemede çift olmaz). 104-108 eski sürümlerden;
// 109 ve sonrası v1.42: kutu ve para birimi, o türden ilk cüzdan eklenince oluşturulur (services.ensureWalletAccount).
// Yeni bir tür eklemek için buraya bir satır, arayüzdeki FALCON_WALLET_KINDS listesine aynı satır eklenir.
const COINS = {
  USDT: { coin: 'USDT', network: 'bsc', account: 104, label: 'USDT (BEP20)', chain: 'bsc', decimals: 18, contract: '0x55d398326f99059ff775485246999027b3197955' },
  BTC: { coin: 'BTC', network: 'btc', account: 105, label: 'BTC (Bitcoin)', chain: 'btc' },
  ETH: { coin: 'ETH', network: 'eth', account: 106, label: 'ETH (Ethereum)', chain: 'eth', decimals: 18 },
  USDT_ERC20: { coin: 'USDT', network: 'eth', account: 107, label: 'USDT (ERC20)', chain: 'eth', decimals: 6, contract: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
  USDT_TRC20: { coin: 'USDT', network: 'tron', account: 108, label: 'USDT (TRC20)', chain: 'tron', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  // v1.42
  LTC: { coin: 'LTC', network: 'ltc', account: 109, label: 'LTC (Litecoin)', chain: 'ltc' },
  DOGE: { coin: 'DOGE', network: 'doge', account: 110, label: 'DOGE (Dogecoin)', chain: 'doge', minInterval: 180 },
  DASH: { coin: 'DASH', network: 'dash', account: 111, label: 'DASH (Dash)', chain: 'dash', minInterval: 180 },
  POL: { coin: 'POL', network: 'polygon', account: 112, label: 'POL (Polygon)', chain: 'polygon', decimals: 18 },
  AVAX: { coin: 'AVAX', network: 'avax', account: 113, label: 'AVAX (Avalanche C-Chain)', chain: 'avax', decimals: 18 },
  ETH_ARB: { coin: 'ETH', network: 'arbitrum', account: 114, label: 'ETH (Arbitrum One)', chain: 'arbitrum', decimals: 18 },
  ETH_BASE: { coin: 'ETH', network: 'base', account: 115, label: 'ETH (Base)', chain: 'base', decimals: 18 },
  ETH_OP: { coin: 'ETH', network: 'optimism', account: 116, label: 'ETH (Optimism)', chain: 'optimism', decimals: 18 },
  TRX: { coin: 'TRX', network: 'tron', account: 117, label: 'TRX (Tron)', chain: 'tron', decimals: 6 },
  XRP: { coin: 'XRP', network: 'xrp', account: 118, label: 'XRP (XRP Ledger)', chain: 'xrp' },
  TON: { coin: 'TON', network: 'ton', account: 119, label: 'TON (Toncoin)', chain: 'ton' },
  USDT_POLYGON: { coin: 'USDT', network: 'polygon', account: 120, label: 'USDT (Polygon)', chain: 'polygon', decimals: 6, contract: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' },
  USDT_ARB: { coin: 'USDT', network: 'arbitrum', account: 121, label: 'USDT (Arbitrum)', chain: 'arbitrum', decimals: 6, contract: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' },
  USDT_AVAX: { coin: 'USDT', network: 'avax', account: 122, label: 'USDT (Avalanche)', chain: 'avax', decimals: 6, contract: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7' },
  USDT_OP: { coin: 'USDT', network: 'optimism', account: 123, label: 'USDT (Optimism)', chain: 'optimism', decimals: 6, contract: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58' },
  USDC_BEP20: { coin: 'USDC', network: 'bsc', account: 124, label: 'USDC (BEP20)', chain: 'bsc', decimals: 18, contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
  USDC_ERC20: { coin: 'USDC', network: 'eth', account: 125, label: 'USDC (ERC20)', chain: 'eth', decimals: 6, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  USDC_POLYGON: { coin: 'USDC', network: 'polygon', account: 126, label: 'USDC (Polygon)', chain: 'polygon', decimals: 6, contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
  USDC_ARB: { coin: 'USDC', network: 'arbitrum', account: 127, label: 'USDC (Arbitrum)', chain: 'arbitrum', decimals: 6, contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  USDC_BASE: { coin: 'USDC', network: 'base', account: 128, label: 'USDC (Base)', chain: 'base', decimals: 6, contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  USDC_OP: { coin: 'USDC', network: 'optimism', account: 129, label: 'USDC (Optimism)', chain: 'optimism', decimals: 6, contract: '0x0b2c639c533813f4aa9d7837caf62653d097ff85' },
  USDC_AVAX: { coin: 'USDC', network: 'avax', account: 130, label: 'USDC (Avalanche)', chain: 'avax', decimals: 6, contract: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e' },
};
// Kasadaki para birimleri (ilk cüzdan eklenince currencies tablosuna yazılır). sort: Kasa sayfasındaki sıra.
const CURRENCIES = {
  USDT: { name: 'Tether USDT', symbol: '₮', sort: 4 },
  BTC: { name: 'Bitcoin', symbol: '₿', sort: 5 },
  ETH: { name: 'Ethereum', symbol: 'Ξ', sort: 6 },
  USDC: { name: 'USD Coin', symbol: 'USDC', sort: 7 },
  LTC: { name: 'Litecoin', symbol: 'Ł', sort: 8 },
  TRX: { name: 'Tron', symbol: 'TRX', sort: 9 },
  XRP: { name: 'XRP', symbol: 'XRP', sort: 10 },
  TON: { name: 'Toncoin', symbol: 'TON', sort: 11 },
  DOGE: { name: 'Dogecoin', symbol: 'Ð', sort: 12 },
  POL: { name: 'Polygon', symbol: 'POL', sort: 13 },
  AVAX: { name: 'Avalanche', symbol: 'AVAX', sort: 14 },
  DASH: { name: 'Dash', symbol: 'DASH', sort: 15 },
};
// Eski kayıtlarda network boştur: coin'e göre varsayılan ağ
const DEFAULT_NETWORK = { USDT: 'bsc', BTC: 'btc', ETH: 'eth', USDC: 'eth', LTC: 'ltc', DOGE: 'doge', DASH: 'dash', POL: 'polygon', AVAX: 'avax', TRX: 'tron', XRP: 'xrp', TON: 'ton' };
function kindOf(coin, network) {
  const net = network || DEFAULT_NETWORK[coin];
  return Object.keys(COINS).find((k) => COINS[k].coin === coin && COINS[k].network === net) || null;
}
const COIN_CODES = Object.keys(COINS);

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BSC_CHUNK = 3000;
const BSC_MAX_CHUNKS = 60;

const ESPLORA = [
  { name: 'mempool.space', base: 'https://mempool.space/api' },
  { name: 'blockstream.info', base: 'https://blockstream.info/api' },
];
const ETH_EXPLORERS = [
  { name: 'eth.blockscout.com', base: 'https://eth.blockscout.com/api' },
  { name: 'routescan.io', base: 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api' },
];
const BSC_EXPLORERS = [{ name: 'routescan.io', base: 'https://api.routescan.io/v2/network/mainnet/evm/56/etherscan/api' }];
const BSC_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb'];
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'];
const TRON_APIS = [
  { name: 'trongrid.io', base: 'https://api.trongrid.io' },
  { name: 'tronscan.org', base: 'https://apilist.tronscanapi.com' },
];
const BLOCKCYPHER = 'https://api.blockcypher.com/v1';
const XRP_RPCS = ['https://xrplcluster.com/', 'https://s2.ripple.com:51234/', 'https://s1.ripple.com:51234/'];
const TONCENTER = 'https://toncenter.com/api/v2';
const bs = (host) => ({ name: host, base: `https://${host}/api` });
const CHAINS = {
  btc: { esplora: ESPLORA },
  ltc: { esplora: [{ name: 'litecoinspace.org', base: 'https://litecoinspace.org/api' }], blockcypher: 'ltc' },
  doge: { esplora: [], blockcypher: 'doge' },
  dash: { esplora: [], blockcypher: 'dash' },
  bsc: { explorers: BSC_EXPLORERS, rpcs: BSC_RPCS, blockSeconds: 0.75 },
  eth: { explorers: ETH_EXPLORERS, rpcs: ETH_RPCS, blockSeconds: 12 },
  polygon: { explorers: [bs('polygon.blockscout.com')], rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://1rpc.io/matic', 'https://polygon.drpc.org'], blockSeconds: 2 },
  arbitrum: { explorers: [bs('arbitrum.blockscout.com')], rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://1rpc.io/arb', 'https://arbitrum.drpc.org'], blockSeconds: 0.25 },
  base: { explorers: [bs('base.blockscout.com')], rpcs: ['https://base-rpc.publicnode.com', 'https://1rpc.io/base', 'https://base.drpc.org'], blockSeconds: 2 },
  optimism: { explorers: [bs('explorer.optimism.io'), bs('optimism.blockscout.com')], rpcs: ['https://optimism-rpc.publicnode.com', 'https://1rpc.io/op', 'https://optimism.drpc.org'], blockSeconds: 2 },
  avax: { explorers: [{ name: 'routescan.io', base: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api' }], rpcs: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://1rpc.io/avax/c', 'https://avalanche.drpc.org'], blockSeconds: 2 },
  tron: {},
  xrp: {},
  ton: {},
};
const ETHPLORER = 'https://api.ethplorer.io';

const host = (u) => new URL(u).hostname;
const WALLET_HOSTS = [
  ...Object.values(CHAINS).flatMap((c) => [...(c.esplora || []), ...(c.explorers || [])].map((s) => host(s.base))),
  ...Object.values(CHAINS).flatMap((c) => (c.rpcs || []).map(host)),
  ...TRON_APIS.map((s) => host(s.base)),
  ...XRP_RPCS.map(host),
  host(BLOCKCYPHER), host(TONCENTER), host(ETHPLORER),
].filter((h, i, a) => a.indexOf(h) === i);

class WalletError extends Error {}

// ---------- Adres denetimi ----------

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
// Girilen metin gizli bilgi gibi görünüyorsa (12/24 kelime, özel anahtar, xprv, XRP gizli anahtarı) hiç saklanmaz
function looksSecret(s) {
  const words = s.trim().split(/\s+/);
  if (words.length >= 11 && words.every((w) => /^[a-zA-Z]{3,12}$/.test(w))) return true;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return true;
  if (new RegExp(`^[5KLc9QT6]${BASE58}{50,51}$`).test(s)) return true;
  if (new RegExp(`^s${BASE58}{28}$`).test(s)) return true;
  if (/^[xyzt]prv/i.test(s) || /^[xyzuvt]prv[1-9A-HJ-NP-Za-km-z]{100,}$/.test(s)) return true;
  return false;
}

// Dönüş: sadeleştirilmiş adres. Hata: ERR_WALLET_SECRET / ERR_WALLET_XPUB / ERR_WALLET_ADDRESS
function normalizeAddress(coin, input) {
  const s = String(input ?? '').trim()
    .replace(/^ton:\/\/transfer\//i, '')
    .replace(/^(bitcoin|ethereum|tron|litecoin|dogecoin|dash|ripple|xrpl|xrp|polygon|avalanche|ton):/i, '')
    .split('?')[0].trim();
  const def = COINS[coin];
  if (!def) throw new WalletError('ERR_WALLET_COIN');
  if (looksSecret(s)) throw new WalletError('ERR_WALLET_SECRET');
  if (/^([xyzuvt]pub|Ltub|Mtub|dgub|drkp)[1-9A-HJ-NP-Za-km-z]{100,}$/.test(s)) throw new WalletError('ERR_WALLET_XPUB');
  const bad = () => { throw new WalletError('ERR_WALLET_ADDRESS'); };
  const sameCase = (x) => x === x.toLowerCase() || x === x.toUpperCase();
  switch (def.chain) {
    case 'btc':
      if (/^bc1[02-9ac-hj-np-z]{11,71}$/i.test(s) && sameCase(s)) return s.toLowerCase();
      if (new RegExp(`^[13]${BASE58}{25,34}$`).test(s)) return s;
      return bad();
    case 'ltc':
      if (/^ltc1[02-9ac-hj-np-z]{11,71}$/i.test(s) && sameCase(s)) return s.toLowerCase();
      if (new RegExp(`^[LM3]${BASE58}{25,34}$`).test(s)) return s;
      return bad();
    case 'doge':
      if (new RegExp(`^[DA9]${BASE58}{25,34}$`).test(s)) return s;
      return bad();
    case 'dash':
      if (new RegExp(`^[X7]${BASE58}{33}$`).test(s)) return s;
      return bad();
    case 'tron':
      if (new RegExp(`^T${BASE58}{33}$`).test(s)) return s;
      return bad();
    case 'xrp':
      if (new RegExp(`^r${BASE58}{24,34}$`).test(s)) return s;
      return bad();
    case 'ton':
      if (/^[EUk0][Qf][A-Za-z0-9_+/-]{46}$/.test(s)) return s;
      if (/^-?\d:[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
      return bad();
    default:
      if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
      return bad();
  }
}

// ---------- Yardımcılar ----------

// Tam sayı metnini (wei, satoshi) ondalıklı birime çevirir; hassasiyet kaybı olmadan
function units(value, decimals) {
  let v;
  try {
    v = BigInt(String(value).trim());
  } catch {
    return 0;
  }
  const base = 10n ** BigInt(decimals);
  return Number(v / base) + Number(v % base) / 10 ** decimals;
}
const hexNum = (h) => Number(BigInt(h));
const toHex = (n) => `0x${Number(n).toString(16)}`;

// HTTP 429 (çok sık istek) gelirse kısa bir beklemeden sonra bir kez daha denenir
async function getJson(fetchFn, url, opts = {}, retry = 1) {
  try {
    return await getJsonOnce(fetchFn, url, opts);
  } catch (err) {
    if (retry > 0 && /^HTTP 429$/.test(err.message)) {
      await new Promise((r) => setTimeout(r, 1500));
      return getJson(fetchFn, url, opts, retry - 1);
    }
    throw err;
  }
}

async function getJsonOnce(fetchFn, url, opts = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetchFn(url, { signal: controller?.signal, ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('invalid json');
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Aynı işlemde birden fazla parça (ör. iç transfer) aynı adrese geldiyse tek kayıtta toplanır
// x: { hash, direction: 'in' | 'out', amount (ücret hariç), fee, time }
function collect(kind, address, list) {
  const coin = kind;
  const map = new Map();
  for (const x of list) {
    const fee = Number(x.fee) || 0;
    if (!(x.amount > 0 || (x.direction === 'out' && fee > 0)) || !x.hash) continue;
    const hash = /^0x/i.test(x.hash) ? x.hash.toLowerCase() : x.hash;
    const direction = x.direction === 'out' ? 'out' : 'in';
    const key = `${coin}:${hash}:${address}${direction === 'out' ? ':out' : ''}`;
    const cur = map.get(key);
    if (cur) {
      cur.amount += Number(x.amount) || 0;
      cur.fee = Math.max(cur.fee, fee);
      cur.time = Math.min(cur.time, x.time);
    } else map.set(key, { key, coin, address, hash, direction, amount: Number(x.amount) || 0, fee, time: x.time });
  }
  return [...map.values()];
}

// ---------- Bitcoin / Litecoin (Esplora: mempool.space, blockstream.info, litecoinspace.org) ----------

async function esploraIncoming(kind, fetchFn, address, since) {
  const errors = [];
  for (const src of CHAINS[COINS[kind].chain].esplora) {
    try {
      const out = [];
      let url = `${src.base}/address/${address}/txs`;
      for (let page = 0; page < 10; page++) {
        const txs = await getJson(fetchFn, url);
        if (!Array.isArray(txs)) throw new Error('invalid data');
        let older = false;
        let lastConfirmed = null;
        let confirmedCount = 0;
        for (const tx of txs) {
          if (!tx?.status?.confirmed) continue; // onaylanmamış ödeme sonraki kontrolde eklenir
          confirmedCount++;
          lastConfirmed = tx.txid;
          const time = Number(tx.status.block_time) || 0;
          if (time < since) {
            older = true;
            continue;
          }
          // Adresten çıkan (harcanan) ve adrese gelen tutarların farkı: artıysa gelen, eksiyse giden ödeme.
          // Giden ödemede para üstü düşülür, ağ ücreti dahildir.
          const spent = (tx.vin || []).filter((i) => i?.prevout?.scriptpubkey_address === address).reduce((a, i) => a + (Number(i.prevout.value) || 0), 0);
          const got = (tx.vout || []).filter((o) => o?.scriptpubkey_address === address).reduce((a, o) => a + (Number(o.value) || 0), 0);
          if (got > spent) out.push({ hash: tx.txid, direction: 'in', amount: (got - spent) / 1e8, time });
          else if (spent > got) {
            const fee = Math.min(Number(tx.fee) || 0, spent - got);
            out.push({ hash: tx.txid, direction: 'out', amount: (spent - got - fee) / 1e8, fee: fee / 1e8, time });
          }
        }
        if (older || confirmedCount < 25 || !lastConfirmed) break;
        url = `${src.base}/address/${address}/txs/chain/${lastConfirmed}`;
      }
      return { items: collect(kind, address, out), source: src.name };
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  if (CHAINS[COINS[kind].chain].blockcypher) {
    try {
      return await blockcypherIncoming(kind, fetchFn, address, since);
    } catch (err) {
      errors.push(`blockcypher.com: ${err.message}`);
    }
  }
  throw Object.assign(new Error('ERR_WALLET_OFFLINE'), { detail: errors.join('; ') });
}

// ---------- Etherscan biçimli gezginler (Blockscout, Routescan) ----------

async function etherscanList(fetchFn, base, params, since) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const q = new URLSearchParams({ ...params, sort: 'desc', page: String(page), offset: '100' });
    const j = await getJson(fetchFn, `${base}?${q}`);
    const list = j?.result;
    if (!Array.isArray(list)) {
      if (String(j?.message || '').toLowerCase().startsWith('no transactions')) break;
      throw new Error(`invalid data: ${String(j?.message || j?.result || '').slice(0, 80)}`);
    }
    out.push(...list);
    if (list.length < 100 || list.some((x) => Number(x.timeStamp) < since)) break;
  }
  return out;
}

// Ağın kendi parası (ETH, POL, AVAX, Arbitrum / Base / Optimism ETH): normal + iç işlemler
async function evmNativeIncoming(kind, fetchFn, address, since) {
  const def = COINS[kind];
  const errors = [];
  for (const src of CHAINS[def.chain].explorers) {
    try {
      const normal = await etherscanList(fetchFn, src.base, { module: 'account', action: 'txlist', address }, since);
      const internal = await etherscanList(fetchFn, src.base, { module: 'account', action: 'txlistinternal', address }, since);
      const failed = (x) => String(x.isError ?? '0') !== '0' || String(x.txreceipt_status ?? '1') === '0';
      const recent = (x) => Number(x.timeStamp) >= since;
      const lc = (v) => String(v || '').toLowerCase();
      const items = [];
      for (const x of [...normal, ...internal].filter(recent)) {
        if (lc(x.to) === address && !failed(x)) items.push({ hash: x.hash, direction: 'in', amount: units(x.value, 18), time: Number(x.timeStamp) });
      }
      // Giden: bu adresten gönderilen işlemler; ağ ücreti (gas) başarısız işlemde de ödenir
      for (const x of normal.filter(recent)) {
        if (lc(x.from) !== address) continue;
        // L2 ağlarında (Optimism, Base) L1 veri ücreti ayrıca ödenir
        const l1 = x.L1FeesPaid || x.l1Fee || 0;
        const fee = (x.gasUsed && x.gasPrice ? units(BigInt(x.gasUsed) * BigInt(x.gasPrice), 18) : 0) + (l1 ? units(l1, 18) : 0);
        items.push({ hash: x.hash, direction: 'out', amount: failed(x) ? 0 : units(x.value, 18), fee, time: Number(x.timeStamp) });
      }
      return { items: collect(kind, address, items), source: src.name };
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  if (def.chain !== 'eth') throw Object.assign(new Error('ERR_WALLET_OFFLINE'), { detail: errors.join('; ') });
  // Son çare: Ethplorer (herkese açık "freekey"), yalnızca doğrudan gönderilen ETH
  try {
    const list = await getJson(fetchFn, `${ETHPLORER}/getAddressTransactions/${address}?apiKey=freekey&limit=50`);
    if (!Array.isArray(list)) throw new Error('invalid data');
    const lc = (v) => String(v || '').toLowerCase();
    const items = list
      .filter((x) => x.success !== false && Number(x.timestamp) >= since && (lc(x.to) === address || lc(x.from) === address))
      .map((x) => ({ hash: x.hash, direction: lc(x.to) === address ? 'in' : 'out', amount: Number(x.value) || 0, time: Number(x.timestamp) }));
    return { items: collect(kind, address, items), source: 'ethplorer.io' };
  } catch (err) {
    errors.push(`ethplorer.io: ${err.message}`);
  }
  throw Object.assign(new Error('ERR_WALLET_OFFLINE'), { detail: errors.join('; ') });
}

// ---------- EVM token transferleri (USDT BEP20 / ERC20) ----------

async function rpc(fetchFn, url, method, params) {
  const j = await getJson(fetchFn, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (j?.error) throw new Error(`rpc ${j.error.code}: ${String(j.error.message || '').slice(0, 80)}`);
  if (j?.result === undefined) throw new Error('invalid data');
  return j.result;
}

// Genel düğümlerden Transfer kayıtları; nereye kadar tarandığı (blok) cihazda saklanır
async function tokenRpcIncoming(kind, fetchFn, url, address, since, state, nowSec) {
  const def = COINS[kind];
  const blockSeconds = CHAINS[def.chain].blockSeconds;
  const latest = hexNum(await rpc(fetchFn, url, 'eth_blockNumber', []));
  const startTime = Math.max(since, (Number(state.lastOk) || 0) - 3600);
  let from = Number(state.bscBlock) > 0 ? Number(state.bscBlock) + 1
    : Math.max(0, latest - Math.ceil(Math.max(0, nowSec - startTime) / blockSeconds) - 400);
  from = Math.max(from, latest - BSC_CHUNK * BSC_MAX_CHUNKS * 4);
  const topic = `0x${'0'.repeat(24)}${address.slice(2)}`;
  const logs = [];
  let chunks = 0;
  while (from <= latest && chunks < BSC_MAX_CHUNKS) {
    const to = Math.min(from + BSC_CHUNK - 1, latest);
    // Gelen (alıcı bu adres) ve giden (gönderen bu adres) transferler
    for (const topics of [[TRANSFER_TOPIC, null, topic], [TRANSFER_TOPIC, topic]]) {
      const part = await rpc(fetchFn, url, 'eth_getLogs', [{ fromBlock: toHex(from), toBlock: toHex(to), address: def.contract, topics }]);
      if (!Array.isArray(part)) throw new Error('invalid data');
      logs.push(...part);
    }
    from = to + 1;
    chunks++;
  }
  const times = new Map();
  for (const l of logs) {
    const b = l.blockNumber;
    if (times.has(b)) continue;
    if (l.blockTimestamp) times.set(b, hexNum(l.blockTimestamp));
    else times.set(b, hexNum((await rpc(fetchFn, url, 'eth_getBlockByNumber', [b, false]))?.timestamp));
  }
  const seen = new Set();
  const items = [];
  for (const l of logs) {
    const id = `${l.transactionHash}:${l.logIndex}`;
    if (l.removed || seen.has(id) || String(l.address).toLowerCase() !== def.contract) continue;
    seen.add(id);
    const toMe = String(l.topics?.[2] || '').toLowerCase() === topic;
    const fromMe = String(l.topics?.[1] || '').toLowerCase() === topic;
    if (toMe === fromMe) continue; // kendi kendine gönderim kasayı değiştirmez
    const time = times.get(l.blockNumber);
    if (time >= since) items.push({ hash: l.transactionHash, direction: toMe ? 'in' : 'out', amount: units(BigInt(l.data), def.decimals), time });
  }
  return { items: collect(kind, address, items), state: { bscBlock: from - 1 } };
}

async function tokenIncoming(kind, fetchFn, address, since, state, nowSec) {
  const def = COINS[kind];
  const errors = [];
  for (const src of CHAINS[def.chain].explorers) {
    try {
      const list = await etherscanList(fetchFn, src.base, { module: 'account', action: 'tokentx', contractaddress: def.contract, address }, since);
      const lc = (v) => String(v || '').toLowerCase();
      const items = list
        .filter((x) => lc(x.contractAddress || def.contract) === def.contract && Number(x.timeStamp) >= since
          && (lc(x.to) === address) !== (lc(x.from) === address))
        .map((x) => ({
          hash: x.hash, direction: lc(x.to) === address ? 'in' : 'out',
          amount: units(x.value, Number(x.tokenDecimal) || def.decimals), time: Number(x.timeStamp),
        }));
      return { items: collect(kind, address, items), source: src.name, state: {} };
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  for (const url of CHAINS[def.chain].rpcs) {
    try {
      const r = await tokenRpcIncoming(kind, fetchFn, url, address, since, state, nowSec);
      return { ...r, source: new URL(url).hostname };
    } catch (err) {
      errors.push(`${new URL(url).hostname}: ${err.message}`);
    }
  }
  throw Object.assign(new Error('ERR_WALLET_OFFLINE'), { detail: errors.join('; ') });
}


// ---------- USDT (TRC20, Tron) ----------
// TronGrid (anahtar gerektirmez, sınırlı hız) → olmazsa Tronscan. Giden transferde ağ ücreti TRX ile ödenir, USDT kasasını etkilemez.
async function tronIncoming(kind, fetchFn, address, since) {
  const def = COINS[kind];
  const errors = [];
  try {
    const src = TRON_APIS[0];
    const items = [];
    let url = `${src.base}/v1/accounts/${address}/transactions/trc20?limit=200&only_confirmed=true&contract_address=${def.contract}&min_timestamp=${since * 1000}`;
    for (let page = 0; page < 10 && url; page++) {
      const j = await getJson(fetchFn, url);
      if (j?.success === false || !Array.isArray(j?.data)) throw new Error(`invalid data: ${String(j?.error || j?.message || '').slice(0, 80)}`);
      for (const x of j.data) {
        if (String(x.type || 'Transfer') !== 'Transfer' || String(x.token_info?.address || def.contract) !== def.contract) continue;
        const time = Math.floor(Number(x.block_timestamp) / 1000);
        const toMe = x.to === address;
        const fromMe = x.from === address;
        if (toMe === fromMe || !(time >= since)) continue;
        items.push({ hash: x.transaction_id, direction: toMe ? 'in' : 'out', amount: units(x.value, Number(x.token_info?.decimals) || def.decimals), time });
      }
      url = j.meta?.links?.next || null;
    }
    return { items: collect(kind, address, items), source: src.name };
  } catch (err) {
    errors.push(`${TRON_APIS[0].name}: ${err.message}`);
  }
  try {
    const src = TRON_APIS[1];
    const items = [];
    for (let start = 0; start < 500; start += 50) {
      const j = await getJson(fetchFn, `${src.base}/api/token_trc20/transfers?limit=50&start=${start}&relatedAddress=${address}&contract_address=${def.contract}`);
      const list = j?.token_transfers;
      if (!Array.isArray(list)) throw new Error('invalid data');
      let older = false;
      for (const x of list) {
        const time = Math.floor(Number(x.block_ts) / 1000);
        if (time < since) {
          older = true;
          continue;
        }
        if ((x.contract_ret && String(x.contract_ret).toUpperCase() !== 'SUCCESS') || x.confirmed === false) continue;
        const toMe = x.to_address === address;
        const fromMe = x.from_address === address;
        if (toMe === fromMe) continue;
        items.push({ hash: x.transaction_id, direction: toMe ? 'in' : 'out', amount: units(x.quant, Number(x.tokenInfo?.tokenDecimal) || def.decimals), time });
      }
      if (older || list.length < 50) break;
    }
    return { items: collect(kind, address, items), source: src.name };
  } catch (err) {
    errors.push(`${TRON_APIS[1].name}: ${err.message}`);
  }
  throw Object.assign(new Error('ERR_WALLET_OFFLINE'), { detail: errors.join('; ') });
}

// ---------- Dogecoin / Dash (ve Litecoin yedeği): BlockCypher ----------
// Anahtarsız kullanımda saatte ~100 istek sınırı vardır; bu yüzden bu türler en sık 3 dakikada bir kontrol edilir (minInterval).
async function blockcypherIncoming(kind, fetchFn, address, since) {
  const net = CHAINS[COINS[kind].chain].blockcypher;
  const out = [];
  let before = null;
  for (let page = 0; page < 5; page++) {
    const j = await getJson(fetchFn, `${BLOCKCYPHER}/${net}/main/addrs/${address}/full?limit=50&txlimit=200${before ? `&before=${before}` : ''}`);
    if (!j || j.error || !Array.isArray(j.txs)) throw new Error(`invalid data: ${String(j?.error || '').slice(0, 80)}`);
    let older = false;
    let minHeight = null;
    for (const tx of j.txs) {
      const height = Number(tx.block_height);
      if (!(height > 0) || !tx.confirmed) continue; // onaylanmamış ödeme sonraki kontrolde eklenir
      minHeight = minHeight === null ? height : Math.min(minHeight, height);
      const time = Math.floor(Date.parse(tx.confirmed) / 1000);
      if (!(time >= since)) {
        older = true;
        continue;
      }
      const mine = (x) => Array.isArray(x?.addresses) && x.addresses.includes(address);
      const spent = (tx.inputs || []).filter(mine).reduce((a, i) => a + (Number(i.output_value) || 0), 0);
      const got = (tx.outputs || []).filter(mine).reduce((a, o) => a + (Number(o.value) || 0), 0);
      if (got > spent) out.push({ hash: tx.hash, direction: 'in', amount: (got - spent) / 1e8, time });
      else if (spent > got) {
        const fee = Math.min(Number(tx.fees) || 0, spent - got);
        out.push({ hash: tx.hash, direction: 'out', amount: (spent - got - fee) / 1e8, fee: fee / 1e8, time });
      }
    }
    if (older || !j.hasMore || minHeight === null) break;
    before = minHeight;
  }
  return { items: collect(kind, address, out), source: 'blockcypher.com' };
}

// ---------- TRX (Tron'un kendi parası) ----------
// Base58 Tron adresi -> 41… biçimli hex (TronGrid yanıtlarındaki biçim)
function tronHex(address) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of address) {
    const i = A.indexOf(ch);
    if (i < 0) throw new WalletError('ERR_WALLET_ADDRESS');
    n = n * 58n + BigInt(i);
  }
  return n.toString(16).padStart(50, '0').slice(0, 42).toLowerCase();
}

// Gelen / giden TRX transferleri; bu adresten gönderilen her işlemin ağ ücreti (USDT TRC20 gönderimi dahil) TRX'ten düşülür.
async function tronNativeIncoming(kind, fetchFn, address, since) {
  const src = TRON_APIS[0];
  const me = tronHex(address);
  const items = [];
  let url = `${src.base}/v1/accounts/${address}/transactions?limit=200&only_confirmed=true&min_timestamp=${since * 1000}`;
  for (let page = 0; page < 10 && url; page++) {
    const j = await getJson(fetchFn, url);
    if (j?.success === false || !Array.isArray(j?.data)) throw new Error(`invalid data: ${String(j?.error || j?.message || '').slice(0, 80)}`);
    for (const x of j.data) {
      const c = x?.raw_data?.contract?.[0];
      const v = c?.parameter?.value || {};
      const time = Math.floor(Number(x.block_timestamp) / 1000);
      if (!c || !(time >= since) || !x.txID) continue;
      const ok = String(x.ret?.[0]?.contractRet || 'SUCCESS') === 'SUCCESS';
      const transfer = c.type === 'TransferContract';
      const from = String(v.owner_address || '').toLowerCase();
      const to = String(v.to_address || '').toLowerCase();
      const amount = transfer && ok ? (Number(v.amount) || 0) / 1e6 : 0;
      if (from === me) {
        const fee = Math.max(Number(x.ret?.[0]?.fee) || 0, (Number(x.net_fee) || 0) + (Number(x.energy_fee) || 0)) / 1e6;
        if (to === me) {
          if (fee > 0) items.push({ hash: x.txID, direction: 'out', amount: 0, fee, time });
        } else items.push({ hash: x.txID, direction: 'out', amount, fee, time });
      } else if (transfer && to === me && amount > 0) items.push({ hash: x.txID, direction: 'in', amount, time });
    }
    url = j.meta?.links?.next || null;
  }
  return { items: collect(kind, address, items), source: src.name };
}

// ---------- XRP (XRP Ledger, herkese açık sunucular) ----------
const RIPPLE_EPOCH = 946684800;
async function xrpIncoming(kind, fetchFn, address, since) {
  const errors = [];
  for (const url of XRP_RPCS) {
    try {
      const items = [];
      let marker;
      for (let page = 0; page < 10; page++) {
        const j = await getJson(fetchFn, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'account_tx', params: [{ account: address, limit: 200, forward: false, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}) }] }),
        });
        const r = j?.result;
        if (r?.status === 'error' && r?.error === 'actNotFound') return { items: [], source: host(url) };
        if (!r || r.status !== 'success' || !Array.isArray(r.transactions)) throw new Error(`invalid data: ${String(r?.error || '').slice(0, 80)}`);
        let older = false;
        for (const t of r.transactions) {
          const tx = t.tx || t.tx_json;
          if (!tx || t.validated === false) continue;
          const time = Number(tx.date) + RIPPLE_EPOCH;
          if (!(time >= since)) {
            older = true;
            continue;
          }
          const hash = t.hash || tx.hash;
          const meta = t.meta || t.metaData || {};
          const ok = meta.TransactionResult === 'tesSUCCESS';
          const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
          // Yalnızca XRP (drops, metin) olarak teslim edilen ödemeler; diğer tokenlar (IOU) sayılmaz
          const xrp = tx.TransactionType === 'Payment' && ok && typeof delivered === 'string' ? Number(delivered) / 1e6 : 0;
          if (tx.Account === address) {
            const fee = (Number(tx.Fee) || 0) / 1e6;
            items.push({ hash, direction: 'out', amount: tx.Destination === address ? 0 : xrp, fee, time });
          } else if (tx.Destination === address && xrp > 0) items.push({ hash, direction: 'in', amount: xrp, time });
        }
        marker = r.marker;
        if (older || !marker) break;
      }
      return { items: collect(kind, address, items), source: host(url) };
    } catch (err) {
      errors.push(`${host(url)}: ${err.message}`);
    }
  }
  throw Object.assign(new Error('ERR_WALLET_OFFLINE'), { detail: errors.join('; ') });
}

// ---------- TON (toncenter.com, anahtarsız: saniyede 1 istek) ----------
async function tonIncoming(kind, fetchFn, address, since) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ address, limit: '50', archival: 'true', ...(cursor || {}) });
    const j = await getJson(fetchFn, `${TONCENTER}/getTransactions?${q}`);
    if (!j?.ok || !Array.isArray(j.result)) throw new Error(`invalid data: ${String(j?.error || '').slice(0, 80)}`);
    let list = j.result;
    if (cursor) list = list.filter((t) => !(t?.transaction_id?.lt === cursor.lt && t?.transaction_id?.hash === cursor.hash));
    let older = false;
    for (const t of list) {
      const time = Number(t.utime);
      const hash = t?.transaction_id?.hash;
      if (!hash) continue;
      if (!(time >= since)) {
        older = true;
        continue;
      }
      const inMsg = t.in_msg || {};
      const external = !inMsg.source; // cüzdanın kendi gönderdiği işlem
      const got = external ? 0 : (Number(inMsg.value) || 0) / 1e9;
      const sent = (t.out_msgs || []).reduce((a, m) => a + (Number(m.value) || 0), 0) / 1e9;
      const fee = (Number(t.fee) || 0) / 1e9;
      if (got > 0) items.push({ hash, direction: 'in', amount: got, time });
      if (sent > 0 || (external && fee > 0)) items.push({ hash, direction: 'out', amount: sent, fee: external ? fee : 0, time });
    }
    const last = j.result[j.result.length - 1]?.transaction_id;
    if (older || j.result.length < 50 || !last) break;
    cursor = { lt: last.lt, hash: last.hash };
  }
  return { items: collect(kind, address, items), source: 'toncenter.com' };
}

// Bir cüzdanın (adres) izleme başladıktan sonraki hareketleri: { items: [{key, coin, address, hash, direction, amount, fee, time}], source, state }
async function fetchWalletTx(wallet, fetchFn, { state = {}, now = Date.now() } = {}) {
  const since = Math.floor(Date.parse(wallet.watch_from) / 1000);
  if (!Number.isFinite(since)) throw new Error('ERR_WALLET_ADDRESS');
  const nowSec = Math.floor(now / 1000);
  const kind = wallet.kind || kindOf(wallet.coin, wallet.network);
  const def = COINS[kind];
  if (!def) throw new Error('ERR_WALLET_COIN');
  const chain = CHAINS[def.chain];
  let r;
  if (chain.esplora) r = await esploraIncoming(kind, fetchFn, wallet.address, since);
  else if (def.chain === 'tron') r = def.contract ? await tronIncoming(kind, fetchFn, wallet.address, since) : await tronNativeIncoming(kind, fetchFn, wallet.address, since);
  else if (def.chain === 'xrp') r = await xrpIncoming(kind, fetchFn, wallet.address, since);
  else if (def.chain === 'ton') r = await tonIncoming(kind, fetchFn, wallet.address, since);
  else if (def.contract) r = await tokenIncoming(kind, fetchFn, wallet.address, since, state, nowSec);
  else r = await evmNativeIncoming(kind, fetchFn, wallet.address, since);
  return { items: r.items, source: r.source, state: { ...state, ...(r.state || {}), lastOk: nowSec } };
}

// Bütün cüzdanları kontrol eder ve yeni hareketleri kasaya yazar. call: hizmetlere giriş (services.call)
async function checkWallets(call, fetchFn, { now = Date.now() } = {}) {
  const wallets = call('listWallets', {});
  const result = { added: [], errors: [], checked: 0 };
  const nowSec = Math.floor(now / 1000);
  const checkOne = async (w) => {
    let state = {};
    try {
      state = w.state ? JSON.parse(w.state) : {};
    } catch {
      state = {};
    }
    // İstek sınırı olan kaynaklar (BlockCypher) en fazla minInterval saniyede bir sorulur
    const def = COINS[w.kind || kindOf(w.coin, w.network)];
    if (def?.minInterval && nowSec - (Number(state.lastTry) || 0) < def.minInterval) return;
    if (def?.minInterval) state = { ...state, lastTry: nowSec };
    try {
      const r = await fetchWalletTx(w, fetchFn, { state, now });
      const saved = call('recordWalletTx', { wallet_id: w.id, items: r.items, state: r.state, source: r.source });
      result.added.push(...saved.added);
      result.checked++;
    } catch (err) {
      const code = /^ERR_[A-Z_]+$/.test(err.message) ? err.message : 'ERR_WALLET_OFFLINE';
      call('recordWalletTx', { wallet_id: w.id, items: [], state, error: `${code}${err.detail ? `: ${err.detail}` : `: ${err.message}`}`.slice(0, 500) });
      result.errors.push({ coin: w.coin, kind: w.kind, address: w.address, error: code });
    }
  };
  // v1.45: farklı ağlar aynı anda sorulur (yavaş bir ağ diğerlerini bekletmez); aynı ağdaki cüzdanlar sırayla (istek sınırı)
  const groups = new Map();
  for (const w of wallets) {
    const def = COINS[w.kind || kindOf(w.coin, w.network)];
    const g = def?.chain || 'x';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(w);
  }
  await Promise.all([...groups.values()].map(async (list) => {
    for (const w of list) await checkOne(w);
  }));
  // v1.44: bir cüzdandan çıkıp başka cüzdana giren paralar swap olarak eşleştirilir
  try {
    result.swaps = call('detectWalletSwaps', {}).swaps || [];
  } catch {
    result.swaps = [];
  }
  return result;
}

// Kasa kaydının numarası işlemden türetilir: iki cihaz aynı ödemeyi bulursa aynı kayıt oluşur (çift sayılmaz).
// Biçim diğer kayıtlarla aynı (saniye * 1.000.000 + 6 hane), böylece sıralama tarihe göre doğru kalır.
function walletTxRowId(key, time) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return Math.max(1, Math.floor(time) - ID_EPOCH) * 1e6 + (h % 1e6);
}

module.exports = {
  COINS, COIN_CODES, CURRENCIES, DEFAULT_NETWORK, kindOf, CHAINS, TRON_APIS, ETH_RPCS, WALLET_HOSTS, ESPLORA, ETH_EXPLORERS, BSC_EXPLORERS, BSC_RPCS, ETHPLORER, TRANSFER_TOPIC,
  normalizeAddress, looksSecret, units, tronHex, fetchWalletTx, checkWallets, walletTxRowId, WalletError,
};
