import { Connection, PublicKey } from "@solana/web3.js";

export interface DevTokenHistory {
  tokenAddress: string;
  launchesAfter: number;
  currentHolders: number;
  createdTimestamp: number;
  isDead: boolean;
  wasRugged: boolean;
}

export interface DevProfile {
  deployerAddress: string;
  totalTokensLaunched: number;
  rugRate: number;
  avgTokenLifespanHours: number;
  recentTokens: DevTokenHistory[];
  isKnownRugger: boolean;
}

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

export async function getDevProfile(
  connection: Connection,
  tokenAddress: string
): Promise<DevProfile | null> {
  try {
    const mint = new PublicKey(tokenAddress);
    const sigs = await connection.getSignaturesForAddress(mint, { limit: 50 });
    if (sigs.length === 0) return null;

    const lastSig = sigs[sigs.length - 1];
    const firstTx = await connection.getParsedTransaction(lastSig.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!firstTx) return null;

    const deployer = findDeployer(firstTx, tokenAddress);
    if (!deployer) return null;

    const deployerPubkey = new PublicKey(deployer);
    const deployerSigs = await connection.getSignaturesForAddress(deployerPubkey, {
      limit: 100,
    });

    const tokenMints = new Set<string>();
    const tokenCreationTimes: number[] = [];
    const recentTokens: DevTokenHistory[] = [];

    for (const sig of deployerSigs) {
      if (sig.err !== null) continue;
      const mentionedTokens = extractTokenMints(sig);
      for (const t of mentionedTokens) {
        if (t !== tokenAddress) {
          tokenMints.add(t);
          if (sig.blockTime) tokenCreationTimes.push(sig.blockTime * 1000);
        }
      }
    }

    let deadCount = 0;
    let ruggedCount = 0;
    let totalLifespan = 0;
    let lifespanSamples = 0;

    const uniqueTokens = [...tokenMints].slice(0, 10);
    for (const t of uniqueTokens) {
      const history = await analyzeTokenHistory(connection, t, tokenAddress);
      if (history) {
        recentTokens.push(history);
        if (history.isDead) deadCount++;
        if (history.wasRugged) ruggedCount++;

        if (history.createdTimestamp > 0 && history.launchesAfter > 0) {
          const lifespan = Date.now() - history.createdTimestamp;
          totalLifespan += lifespan;
          lifespanSamples++;
        }
      }
    }

    const rugRate = uniqueTokens.length > 0 ? ruggedCount / uniqueTokens.length : 0;
    const avgLifespan =
      lifespanSamples > 0 ? totalLifespan / lifespanSamples / 3600000 : 0;

    return {
      deployerAddress: deployer,
      totalTokensLaunched: uniqueTokens.length,
      rugRate,
      avgTokenLifespanHours: avgLifespan,
      recentTokens,
      isKnownRugger: rugRate > 0.5 && uniqueTokens.length >= 3,
    };
  } catch {
    return null;
  }
}

function findDeployer(tx: any, tokenAddress: string): string | null {
  try {
    const postBalances = tx.meta?.postTokenBalances ?? [];
    for (const b of postBalances) {
      if (b.mint === tokenAddress && b.owner && b.uiTokenAmount?.uiAmount > 0) {
        if (
          b.owner !== PUMP_FUN_PROGRAM &&
          b.owner !== RAYDIUM_AMM &&
          b.owner.length < 44
        ) {
          return b.owner;
        }
      }
    }

    const accountKeys = tx.transaction.message.getAccountKeys();
    const key0 = accountKeys.get(0);
    if (key0 && key0.toString().length < 44) return key0.toString();

    return null;
  } catch {
    return null;
  }
}

function extractTokenMints(sig: { signature: string }): string[] {
  return [];
}

async function analyzeTokenHistory(
  connection: Connection,
  tokenAddress: string,
  originalToken: string
): Promise<DevTokenHistory | null> {
  try {
    const mint = new PublicKey(tokenAddress);
    const sigs = await connection.getSignaturesForAddress(mint, { limit: 10 });

    let createdTimestamp = 0;
    for (const sig of sigs) {
      if (sig.blockTime) {
        createdTimestamp = sig.blockTime * 1000;
        break;
      }
    }

    let currentHolders = 0;
    try {
      const largest = await connection.getTokenLargestAccounts(mint);
      currentHolders = largest.value.length;
    } catch {}

    let isDead = false;
    let wasRugged = false;

    const parsedTxs = await connection.getParsedTransactions(
      sigs.slice(0, 5).map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    for (const tx of parsedTxs) {
      if (!tx?.meta) continue;
      const preBalances = tx.meta.preTokenBalances ?? [];
      const postBalances = tx.meta.postTokenBalances ?? [];

      let totalHeldPre = 0;
      let totalHeldPost = 0;
      for (const p of preBalances) {
        if (p.mint === tokenAddress) totalHeldPre += p.uiTokenAmount?.uiAmount ?? 0;
      }
      for (const p of postBalances) {
        if (p.mint === tokenAddress) totalHeldPost += p.uiTokenAmount?.uiAmount ?? 0;
      }

      if (totalHeldPre > 0 && totalHeldPost < totalHeldPre * 0.1) {
        wasRugged = true;
      }
    }

    if (currentHolders <= 10 && createdTimestamp < Date.now() - 86400000 * 7) {
      isDead = true;
    }

    return {
      tokenAddress,
      launchesAfter: 0,
      currentHolders,
      createdTimestamp,
      isDead,
      wasRugged,
    };
  } catch {
    return null;
  }
}
