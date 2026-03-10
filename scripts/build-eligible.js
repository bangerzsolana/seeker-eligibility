import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { writeFileSync } from 'fs';

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const TOURNAMENTS = [
  { name: 'seeker',  pubkey: 'HyshNtZUbGefnqj3CnqWXnjeRFKetzk1U8V9oyBwtu9m' },
  { name: 'seeker2', pubkey: '8EWqdMpKMhfKgs1oTAuBkGa2KZRJ93ufW6fMPkFFtNgg' },
  { name: 'seeker3', pubkey: '5t2Gra57u4cj5bJPQ2ZRNfUusjQs3UVCUZ2MUuhANZk5' },
  { name: 'seeker4', pubkey: '2kWJ1tameoh95JWR4kCe1hKhpo7gMjso4uVExDFqiw2r' },
  { name: 'seeker5', pubkey: 'Cink4FQ11nTW1gcSzaSJzzK2MvRvj5E9EPtjJVswcq4b' },
];

const HEADER_SIZE = 54;
const RULES_SIZE = 140;
const CLASE_8_EXTRA = 20;

function parseWallets(data, tournamentName) {
  const clase = data[8];
  const slotSize = clase === 6 ? 175 : 127;

  let offset = HEADER_SIZE + RULES_SIZE;
  if (clase === 8) offset += CLASE_8_EXTRA;

  const wallets = [];
  while (offset + slotSize <= data.length) {
    const available = data[offset];
    if (available === 1) {
      const pubkeyBytes = data.slice(offset + 4, offset + 36);
      const wallet = bs58.encode(pubkeyBytes);
      wallets.push(wallet);
    }
    offset += slotSize;
  }
  console.log(`  ${tournamentName}: clase=${clase}, slotSize=${slotSize}, found ${wallets.length} wallets`);
  return wallets;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  // wallet -> [tournament names]
  const eligibleMap = {};

  for (const { name, pubkey } of TOURNAMENTS) {
    console.log(`Fetching ${name} (${pubkey})...`);
    const accountInfo = await connection.getAccountInfo(new PublicKey(pubkey));
    if (!accountInfo) {
      console.warn(`  WARNING: account not found for ${name}`);
      continue;
    }
    const data = accountInfo.data;
    const wallets = parseWallets(data, name);
    for (const wallet of wallets) {
      if (!eligibleMap[wallet]) eligibleMap[wallet] = [];
      if (!eligibleMap[wallet].includes(name)) eligibleMap[wallet].push(name);
    }
  }

  const totalWallets = Object.keys(eligibleMap).length;
  console.log(`\nTotal unique eligible wallets: ${totalWallets}`);

  writeFileSync(
    new URL('../eligible-wallets.json', import.meta.url),
    JSON.stringify(eligibleMap, null, 2)
  );
  console.log('Written to eligible-wallets.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
