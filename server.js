import 'dotenv/config';
import express from 'express';
import { Connection } from '@solana/web3.js';
import { TldParser } from '@onsol/tldparser';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';

// Optional DB connection — enriches results with GibMeme account + NFT data
// Set DATABASE_URL in Railway to enable; app works without it
const db = process.env.DATABASE_URL ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
}) : null;

const THREE_LAND_PROGRAM = 'HgtiJuEcdN6bN6WyYpamL3QKpyMcF8g8FxutDQNB96J9';
const HELIUS_API = `https://api.helius.xyz/v0`;

// Count all-time NFT purchases by paging through the wallet's Helius tx history.
// A purchase = a transaction where the wallet is feePayer AND involves the 3.land program.
async function getNftCount(wallet) {
  try {
    let count = 0;
    let before = undefined;
    while (true) {
      const url = new URL(`${HELIUS_API}/addresses/${wallet}/transactions`);
      url.searchParams.set('api-key', process.env.HELIUS_API_KEY);
      url.searchParams.set('limit', '100');
      if (before) url.searchParams.set('before', before);

      const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) break;
      const txs = await resp.json();
      if (!txs?.length) break;

      for (const tx of txs) {
        if (tx.feePayer !== wallet) continue;
        const accounts = tx.accountData?.map(a => a.account) || [];
        if (accounts.includes(THREE_LAND_PROGRAM)) count++;
      }

      if (txs.length < 100) break;
      before = txs[txs.length - 1].signature;
    }
    return count;
  } catch {
    return null;
  }
}

async function getWalletProfile(wallet) {
  const usernamePromise = db
    ? db.query('SELECT username FROM wallet_usernames WHERE wallet = $1', [wallet])
        .then(r => r.rows[0]?.username || null)
        .catch(() => null)
    : Promise.resolve(null);

  const [username, nftCount] = await Promise.all([
    usernamePromise,
    getNftCount(wallet),
  ]);

  return { username, nftCount: nftCount ?? 0 };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PORT = process.env.PORT || 3000;

// Load eligible wallets
const eligiblePath = path.join(__dirname, 'eligible-wallets.json');
if (!existsSync(eligiblePath)) {
  console.error('eligible-wallets.json not found. Run: npm run build');
  process.exit(1);
}
const eligibleMap = JSON.parse(readFileSync(eligiblePath, 'utf8'));
console.log(`Loaded ${Object.keys(eligibleMap).length} eligible wallets`);

const connection = new Connection(RPC_URL, 'confirmed');
const parser = new TldParser(connection);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/check/:domain', async (req, res) => {
  let domain = req.params.domain.trim().toLowerCase();
  if (!domain.endsWith('.skr')) domain += '.skr';

  try {
    let ownerPubkey;
    try {
      ownerPubkey = await parser.getOwnerFromDomainTld(domain);
    } catch {
      // tldparser throws when domain doesn't exist
      ownerPubkey = null;
    }

    if (!ownerPubkey) {
      return res.json({ domain, wallet: null, eligible: false, error: 'Domain not found' });
    }

    const wallet = ownerPubkey.toBase58();
    const tournaments = eligibleMap[wallet] || [];
    const eligible = tournaments.length > 0;
    const { username, nftCount } = await getWalletProfile(wallet);

    res.json({ domain, wallet, eligible, tournaments, username, nftCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ domain, error: 'Resolution failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Seeker eligibility checker running on http://localhost:${PORT}`);
});
