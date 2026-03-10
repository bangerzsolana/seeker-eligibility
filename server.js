import 'dotenv/config';
import express from 'express';
import { Connection } from '@solana/web3.js';
import { TldParser } from '@onsol/tldparser';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

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

    res.json({ domain, wallet, eligible, tournaments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ domain, error: 'Resolution failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Seeker eligibility checker running on http://localhost:${PORT}`);
});
