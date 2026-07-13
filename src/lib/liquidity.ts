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
  let lpMint: string | null = null;
  let pairAddress: string | null = null;
  let liquidityUsd = 0;

  // 1. Get pair info from DexScreener
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
    }
  } catch { /* skip */ }

  // 2. Extract LP mint from AMM pool account data (Raydium V4 layout)
  if (pairAddress) {
    try {
      const poolPubkey = new PublicKey(pairAddress);
      const accountInfo = await connection.getAccountInfo(poolPubkey);
      if (accountInfo?.data && accountInfo.data.length >= 104) {
        // Raydium V4 layout: lpMint at offset 72 (32 bytes)
        const lpMintBytes = accountInfo.data.slice(72, 104);
        lpMint = new PublicKey(lpMintBytes).toBase58();
      }
    } catch { /* skip */ }
  }

  // 3. Fallback: find LP via transaction history
  if (!lpMint) {
    try {
      lpMint = await findLPMintViaTxs(connection, tokenAddress);
    } catch { /* skip */ }
  }

  if (!lpMint) {
    return {
      hasLP: false, lpMint: null, totalLP: 0, burnedLP: 0,
      burnedPercent: 0, lockedLP: 0, lockedPercent: 0,
      topLPHolderShare: 0, deployerHoldsLP: false,
      status: "NO_LP", risk: "VERY_HIGH", pairAddress, liquidityUsd,
    };
  }

  // 4. Analyze LP holders
  try {
    let totalLP = 0;
    try {
      const supply = await connection.getTokenSupply(new PublicKey(lpMint));
      totalLP = supply.value.uiAmount ?? 0;
    } catch {
      return { hasLP: true, lpMint, totalLP: 0, burnedLP: 0, burnedPercent: 0, lockedLP: 0, lockedPercent: 0, topLPHolderShare: 0, deployerHoldsLP: false, status: "ERROR", risk: "VERY_HIGH", pairAddress, liquidityUsd };
    }

    const largestHolds = await getLPHolders(connection, lpMint);

    let burnedLP = 0;
    let deployedLP = 0;
    let topHolderLP = 0;

    for (let i = 0; i < Math.min(largestHolds.length, 20); i++) {
      const acc = largestHolds[i];
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(acc.address));
        const owner = (info.value?.data as any)?.parsed?.info?.owner ?? "";
        if (BURN_ADDRESSES.has(owner)) burnedLP += acc.uiAmount;
        if (owner === deployer && deployer !== "unknown") deployedLP += acc.uiAmount;
        if (i === 0) topHolderLP = acc.uiAmount;
      } catch {}
    }

    const burnedPercent = totalLP > 0 ? burnedLP / totalLP : 0;
    const topLPHolderShare = totalLP > 0 ? topHolderLP / totalLP : 0;

    let status: LiquidityLockResult["status"];
    let risk: LiquidityLockResult["risk"];

    if (burnedPercent > 0.9) { status = "BURNED"; risk = "SAFE"; }
    else if (burnedPercent > 0.5) { status = "BURNED"; risk = "MODERATE"; }
    else if (burnedPercent > 0.1) { status = "BURNED"; risk = "MODERATE"; }
    else if (deployedLP > 0 && deployedLP / totalLP > 0.3) { status = "UNLOCKED"; risk = "HIGH"; }
    else if (topLPHolderShare > 0.8) { status = "UNLOCKED"; risk = "HIGH"; }
    else { status = "UNLOCKED"; risk = "VERY_HIGH"; }

    return {
      hasLP: true, lpMint, totalLP, burnedLP, burnedPercent,
      lockedLP: 0, lockedPercent: 0,
      topLPHolderShare, deployerHoldsLP: deployedLP > 0,
      status, risk, pairAddress, liquidityUsd,
    };
  } catch {
    return { hasLP: true, lpMint, totalLP: 0, burnedLP: 0, burnedPercent: 0, lockedLP: 0, lockedPercent: 0, topLPHolderShare: 0, deployerHoldsLP: false, status: "ERROR", risk: "VERY_HIGH", pairAddress, liquidityUsd };
  }
}

async function findLPMintViaTxs(connection: Connection, tokenAddress: string): Promise<string | null> {
  try {
    const mint = new PublicKey(tokenAddress);
    const sigs = await connection.getSignaturesForAddress(mint, { limit: 30 });

    for (let i = 0; i < Math.min(sigs.length, 20); i += 5) {
      const batch = sigs.slice(i, i + 5);
      await new Promise(r => setTimeout(r, 250));
      try {
        const txs = await connection.getParsedTransactions(
          batch.map(s => s.signature),
          { maxSupportedTransactionVersion: 0 }
        );
        for (const tx of txs) {
          if (!tx?.meta) continue;
          const postBalances = tx.meta.postTokenBalances ?? [];
          for (const b of postBalances) {
            if (b.mint !== tokenAddress && b.mint !== WSOL && (b.uiTokenAmount?.uiAmount ?? 0) > 0) {
              return b.mint;
            }
          }
        }
      } catch {}
    }
    return null;
  } catch { return null; }
}

async function getLPHolders(connection: Connection, lpMint: string): Promise<{ address: string; uiAmount: number }[]> {
  // Try standard method first
  try {
    const result = await connection.getTokenLargestAccounts(new PublicKey(lpMint));
    return result.value.map((a: any) => ({ address: a.address, uiAmount: a.uiAmount || 0 }));
  } catch {
    // Fallback: raw RPC getProgramAccounts
    try {
      const rpcUrl = connection.rpcEndpoint;
      const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
        params: [TOKEN_PROGRAM, {
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: lpMint } }],
          encoding: "jsonParsed",
        }],
      }, { timeout: 15000 });

      if (data.error) return [];
      const accounts = (data.result || []).map((acc: any) => ({
        address: acc.pubkey,
        uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount || 0,
      }));
      accounts.sort((a: any, b: any) => b.uiAmount - a.uiAmount);
      return accounts;
    } catch {
      return [];
    }
  }
}
