import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { Connection } from '@solana/web3.js';
import { TldParser } from '@onsol/tldparser';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL   = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PORT      = process.env.PORT || 3000;

const THREE_LAND_ADDRESS = '6ANLCD4JF8Je7YmsoD3dkMSgGeAPQT2o4ob1NVcWQN5y';
const THREE_LAND_PROGRAM = 'HgtiJuEcdN6bN6WyYpamL3QKpyMcF8g8FxutDQNB96J9';

// ── DB (optional) ─────────────────────────────────────────
const db = process.env.DATABASE_URL ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
}) : null;

// ── Purchase sync (mirrors dashboard logic) ───────────────
function anchorDisc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8).toString('hex');
}
const BUY_PACK_DISC = anchorDisc('buy_pack');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad b58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Buffer.from(out);
}

function hasBuyPack(tx) {
  for (const ix of tx.instructions || []) {
    if (ix.programId === THREE_LAND_PROGRAM && ix.data) {
      try { if (b58decode(ix.data).slice(0, 8).toString('hex') === BUY_PACK_DISC) return true; }
      catch { /* skip */ }
    }
  }
  return false;
}

function processTx(tx) {
  const buyerData = (tx.accountData || []).find(ad => ad.account === tx.feePayer);
  const lamports  = Math.abs(buyerData?.nativeBalanceChange || 0);
  return { signature: tx.signature, timestamp: tx.timestamp, buyer: tx.feePayer, lamports, sol: lamports / 1e9 };
}

async function heliusFetch(before = null) {
  let url = `https://api-mainnet.helius-rpc.com/v0/addresses/${THREE_LAND_ADDRESS}/transactions?api-key=${process.env.HELIUS_API_KEY}&limit=100`;
  if (before) url += `&before=${before}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Helius ${res.status}`);
  return res.json();
}

async function dbNewestSignature() {
  if (!db) return null;
  const { rows } = await db.query('SELECT signature FROM purchases ORDER BY timestamp DESC LIMIT 1');
  return rows[0]?.signature || null;
}

async function dbSave(purchases) {
  if (!db || purchases.length === 0) return;
  const vals   = purchases.map((_, i) => `($${i*5+1},$${i*5+2},$${i*5+3},$${i*5+4},$${i*5+5})`).join(',');
  const params = purchases.flatMap(p => [p.signature, p.timestamp, p.buyer, p.lamports, p.sol]);
  await db.query(
    `INSERT INTO purchases (signature,timestamp,buyer,lamports,sol) VALUES ${vals} ON CONFLICT (signature) DO NOTHING`,
    params
  );
}

// Fetch any purchases newer than what's in the DB and save them
async function syncLatestPurchases() {
  if (!db) return;
  try {
    const knownSig = await dbNewestSignature();
    const newPurchases = [];
    let before = null;

    for (let page = 0; page < 20; page++) {
      const txs = await heliusFetch(before);
      if (!txs?.length) break;

      const stopIdx = knownSig ? txs.findIndex(tx => tx.signature === knownSig) : -1;
      if (stopIdx >= 0) {
        newPurchases.push(...txs.slice(0, stopIdx).filter(hasBuyPack).map(processTx));
        break;
      }

      newPurchases.push(...txs.filter(hasBuyPack).map(processTx));
      before = txs[txs.length - 1].signature;
      if (txs.length < 100) break;
    }

    if (newPurchases.length > 0) {
      await dbSave(newPurchases);
      console.log(`Seeker sync: +${newPurchases.length} new purchases`);
    }
  } catch (err) {
    console.error('Seeker sync error:', err.message);
  }
}

// ── Username sync ──────────────────────────────────────────
async function syncUsernames() {
  if (!db) return;
  try {
    const res = await fetch('https://api.gib.meme/account/users/list4adminz', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const raw  = await res.json();
    const arr  = raw.list || (Array.isArray(raw) ? raw : []);
    const users = arr.filter(u => Array.isArray(u) && u[0] && u[1]).map(u => ({ wallet: u[0], username: u[1] }));
    const BATCH = 500;
    for (let i = 0; i < users.length; i += BATCH) {
      const batch  = users.slice(i, i + BATCH);
      const vals   = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(', ');
      const params = batch.flatMap(u => [u.wallet, u.username]);
      await db.query(
        `INSERT INTO wallet_usernames (wallet, username) VALUES ${vals} ON CONFLICT (wallet) DO UPDATE SET username = EXCLUDED.username`,
        params
      );
    }
    console.log(`Username sync: ${users.length} users upserted`);
  } catch (err) {
    console.error('Username sync error:', err.message);
  }
}

// ── Tournament number lookup ───────────────────────────────
async function getTournamentNumbers(tourn_accts) {
  if (!tourn_accts.length) return [];
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const pubkeys  = tourn_accts.map(a => new PublicKey(a));
    const accounts = await connection.getMultipleAccountsInfo(pubkeys);
    const nums = [];
    for (const acct of accounts) {
      if (acct?.data?.length > 29) {
        const n = acct.data.readUInt32LE(26);
        if (n > 0) nums.push(n);
      }
    }
    return [...new Set(nums)].sort((a, b) => a - b).map(n => `#${n}`);
  } catch {
    return [];
  }
}

// ── Wallet profile ─────────────────────────────────────────
async function getWalletProfile(wallet) {
  if (!db) return { username: null, nftCount: 0, playedElsewhere: false, otherTournaments: [] };
  try {
    const [accRow, nftRow, tournRow] = await Promise.all([
      db.query('SELECT username FROM wallet_usernames WHERE wallet = $1', [wallet]),
      db.query('SELECT COUNT(*) AS cnt FROM purchases WHERE buyer = $1', [wallet]),
      db.query('SELECT DISTINCT tourn_acct FROM tourn_events WHERE player = $1 AND type = $2', [wallet, 'register']),
    ]);
    const otherTournaments = await getTournamentNumbers(tournRow.rows.map(r => r.tourn_acct));
    return {
      username: accRow.rows[0]?.username || null,
      nftCount: parseInt(nftRow.rows[0]?.cnt || 0),
      playedElsewhere: otherTournaments.length > 0,
      otherTournaments,
    };
  } catch {
    return { username: null, nftCount: 0, playedElsewhere: false, otherTournaments: [] };
  }
}

// ── App ───────────────────────────────────────────────────
const eligiblePath = path.join(__dirname, 'eligible-wallets.json');
if (!existsSync(eligiblePath)) { console.error('eligible-wallets.json not found.'); process.exit(1); }
const eligibleMap = JSON.parse(readFileSync(eligiblePath, 'utf8'));
console.log(`Loaded ${Object.keys(eligibleMap).length} eligible wallets`);

const connection = new Connection(RPC_URL, 'confirmed');
const parser     = new TldParser(connection);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/check/:domain', async (req, res) => {
  let domain = req.params.domain.trim().toLowerCase();
  if (!domain.endsWith('.skr')) domain += '.skr';

  try {
    // Sync latest purchases before querying so fresh mints show up
    await syncLatestPurchases();

    let ownerPubkey;
    try { ownerPubkey = await parser.getOwnerFromDomainTld(domain); }
    catch { ownerPubkey = null; }

    if (!ownerPubkey) {
      return res.json({ domain, wallet: null, eligible: false, error: 'Domain not found' });
    }

    const wallet     = ownerPubkey.toBase58();
    const tournaments = eligibleMap[wallet] || [];
    const eligible   = tournaments.length > 0;
    const { username, nftCount, playedElsewhere, otherTournaments } = await getWalletProfile(wallet);

    res.json({ domain, wallet, eligible, tournaments, username, nftCount, playedElsewhere, otherTournaments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ domain, error: 'Resolution failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Seeker eligibility checker running on http://localhost:${PORT}`);
  syncUsernames();
  setInterval(syncUsernames, 60 * 60 * 1000); // re-sync every hour
});
