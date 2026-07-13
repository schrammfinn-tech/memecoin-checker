import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";

export interface LiquidityLockResult {
  hasLP: boolean;
  lpMint: string | null;
  totalLP: number;
  burnedLP: number;
  burnedPercent: number;
  lockedLP: number;
  lockedPercent: number;
  topLPHolderShare: number;
  deployerHoldsLP: boolean;
  status: "BURNED" | "LOCKED" | "UNLOCKED" | "NO_LP" | "ERROR";
  risk: "SAFE" | "MODERATE" | "HIGH" | "VERY_HIGH";
  pairAddress: string | null;
  liquidityUsd: number;
}

const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const WSOL = "So11111111111111111111111111111111111111112";
const BURN_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "DeadDeadDeadDeadDeadDeadDeadDeadDeadDead",
  "1nc1nerator11111111111111111111111111111111",
]);

export async function analyzeLiquidityLock(
  connection: Connection,
  tokenAddress: string,
  deployer: string
): Promise<LiquidityLockResult> {
  // Try DexScreener first for pair info
  let lpMint: string | null = null;
  let pairAddress: string | null = null;
  let liquidityUsd = 0;

  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { timeout: 8000 }
    );
    const pairs = data.pairs || [];
    if (pairs.length > 0) {
      const best = pairs.reduce((a: any, b: any) =>
        (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b
      );
      pairAddress = best.pairAddress || null;
      liquidityUsd = best.liquidity?.usd || 0;

      // Try to get LP mint from the pool
      if (pairAddress) {
        try {
          const poolPubkey = new PublicKey(pairAddress);
          const poolInfo = await connection.getParsedAccountInfo(poolPubkey);
          if (poolInfo.value) {
            const parsed = (poolInfo.value.data as any)?.parsed?.info;
            lpMint = parsed?.lpMint || null;
          }
        } catch {}
      }
    }
  } catch {}

  // Fallback: find LP mint via Raydium PDA
  if (!lpMint) {
    try {
      lpMint = await findLPMintOnChain(connection, tokenAddress);
    } catch {}
  }

  if (!lpMint) {
    return {
      hasLP: false, lpMint: null, totalLP: 0, burnedLP: 0,
      burnedPercent: 0, lockedLP: 0, lockedPercent: 0,
      topLPHolderShare: 0, deployerHoldsLP: false,
      status: "NO_LP", risk: "VERY_HIGH",
      pairAddress, liquidityUsd,
    };
  }

  try {
    let totalLP = 0;
    try {
      const supply = await connection.getTokenSupply(new PublicKey(lpMint));
      totalLP = supply.value.uiAmount ?? 0;
    } catch {
      return { hasLP: true, lpMint, totalLP: 0, burnedLP: 0, burnedPercent: 0, lockedLP: 0, lockedPercent: 0, topLPHolderShare: 0, deployerHoldsLP: false, status: "ERROR", risk: "VERY_HIGH", pairAddress, liquidityUsd };
    }

    // Get LP holders via getTokenLargestAccounts with fallback
    let largestHolds: { address: string; uiAmount: number }[] = [];
    try {
      const result = await connection.getTokenLargestAccounts(new PublicKey(lpMint));
      largestHolds = result.value.map((a: any) => ({ address: a.address, uiAmount: a.uiAmount || 0 }));
    } catch {
      // Fallback: getProgramAccounts for LP mint
      largestHolds = await getLPHoldersFallback(connection, lpMint);
    }

    let burnedLP = 0;
    let lockedLP = 0;
    let deployerLP = 0;
    let topHolderLP = 0;

    // Check owners - batch of top 10
    for (let i = 0; i < Math.min(largestHolds.length, 10); i++) {
      const acc = largestHolds[i];
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(acc.address));
        const owner = (info.value?.data as any)?.parsed?.info?.owner ?? "";

        if (BURN_ADDRESSES.has(owner)) {
          burnedLP += acc.uiAmount;
        }
        if (owner === deployer) {
          deployerLP += acc.uiAmount;
        }
        if (i === 0) {
          topHolderLP = acc.uiAmount;
        }
      } catch {}
    }

    const burnedPercent = totalLP > 0 ? burnedLP / totalLP : 0;
    const topLPHolderShare = totalLP > 0 ? topHolderLP / totalLP : 0;

    let status: LiquidityLockResult["status"] = "UNLOCKED";
    let risk: LiquidityLockResult["risk"] = "VERY_HIGH";

    if (burnedPercent > 0.9) {
      status = "BURNED";
      risk = "SAFE";
    } else if (burnedPercent > 0.5) {
      status = "BURNED";
      risk = "MODERATE";
    } else if (lockedLP > 0 && lockedLP / totalLP > 0.3) {
      status = "LOCKED";
      risk = "MODERATE";
    } else if (deployerLP > 0 && deployerLP / totalLP > 0.3) {
      status = "UNLOCKED";
      risk = "HIGH";
    } else {
      status = "UNLOCKED";
      risk = topLPHolderShare > 0.8 ? "HIGH" : "VERY_HIGH";
    }

    return {
      hasLP: true, lpMint, totalLP, burnedLP, burnedPercent,
      lockedLP, lockedPercent: totalLP > 0 ? lockedLP / totalLP : 0,
      topLPHolderShare, deployerHoldsLP: deployerLP > 0,
      status, risk, pairAddress, liquidityUsd,
    };
  } catch {
    return { hasLP: true, lpMint, totalLP: 0, burnedLP: 0, burnedPercent: 0, lockedLP: 0, lockedPercent: 0, topLPHolderShare: 0, deployerHoldsLP: false, status: "ERROR", risk: "VERY_HIGH", pairAddress, liquidityUsd };
  }
}

async function findLPMintOnChain(connection: Connection, tokenAddress: string): Promise<string | null> {
  try {
    const mint = new PublicKey(tokenAddress);
    const wsol = new PublicKey(WSOL);

    // Raydium V4 AMM pool PDA: seeds = [base_mint, quote_mint]
    // The pool always uses the two tokens sorted by their mint addresses
    const [baseMint, quoteMint] = mint.toBase58() < wsol.toBase58()
      ? [mint, wsol]
      : [wsol, mint];

    // Find pool based on OpenBook market - but that's complex.
    // Simpler: search recent tx signatures for LP mint
    const sigs = await connection.getSignaturesForAddress(mint, { limit: 20 });

    // Batch parse in groups of 5
    for (let i = 0; i < sigs.length; i += 5) {
      const batch = sigs.slice(i, i + 5);
      await new Promise(r => setTimeout(r, 200));
      try {
        const txs = await connection.getParsedTransactions(
          batch.map(s => s.signature),
          { maxSupportedTransactionVersion: 0 }
        );

        for (const tx of txs) {
          if (!tx?.meta) continue;
          const postBalances = tx.meta.postTokenBalances ?? [];
          for (const b of postBalances) {
            if (
              b.mint !== tokenAddress &&
              b.mint !== WSOL &&
              (b.uiTokenAmount?.uiAmount ?? 0) > 0
            ) {
              const candidate = b.mint;
              try {
                const supply = await connection.getTokenSupply(new PublicKey(candidate));
                const amt = supply.value.uiAmount ?? 0;
                // LP tokens typically have supply < 1B
                if (amt > 0 && amt < 1000000000 && supply.value.decimals > 0) {
                  return candidate;
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    return null;
  } catch { return null; }
}

async function getLPHoldersFallback(connection: Connection, lpMint: string): Promise<{ address: string; uiAmount: number }[]> {
  try {
    const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const body = {
      jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
      params: [TOKEN_PROGRAM, {
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: lpMint } }
        ],
        encoding: "jsonParsed",
      }],
    };

    // Use raw RPC via axios to bypass Connection class issues
    const rpcUrl = connection.rpcEndpoint;
    const { data } = await axios.post(rpcUrl, body, { timeout: 15000 });
    if (data.error) throw new Error(data.error.message);

    const accounts: { address: string; uiAmount: number }[] = [];
    for (const acc of data.result || []) {
      const info = acc.account.data.parsed.info;
      const uiAmount = info.tokenAmount.uiAmount || 0;
      if (uiAmount > 0) {
        accounts.push({ address: acc.pubkey, uiAmount });
      }
    }
    accounts.sort((a, b) => b.uiAmount - a.uiAmount);
    return accounts;
  } catch {
    return [];
  }
}
