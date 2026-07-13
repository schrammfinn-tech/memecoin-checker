import { Connection, PublicKey } from "@solana/web3.js";

export interface BundleGroup {
  wallets: string[];
  buyTimestamp: number;
  buyAmounts: number[];
  sameBlock: boolean;
  commonFunder: string | null;
  tokenAmount: number;
}

export interface BundleDetectionResult {
  isBundled: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  bundleGroups: BundleGroup[];
  totalBundleShare: number;
  firstBuyTimestamp: number;
  uniqueFunders: number;
}

const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

function findCommonFunder(
  windowEvents: { buyer: string; feePayer: string }[]
): string | null {
  const payerBuyers = new Map<string, Set<string>>();
  for (const e of windowEvents) {
    if (!payerBuyers.has(e.feePayer)) {
      payerBuyers.set(e.feePayer, new Set());
    }
    payerBuyers.get(e.feePayer)!.add(e.buyer);
  }
  for (const [payer, buyers] of payerBuyers) {
    if (buyers.size >= 2) return payer;
  }
  return null;
}

export async function detectBundledLaunch(
  connection: Connection,
  tokenAddress: string,
  totalSupply: number
): Promise<BundleDetectionResult> {
  const emptyResult = (): BundleDetectionResult => ({
    isBundled: false,
    confidence: "NONE",
    bundleGroups: [],
    totalBundleShare: 0,
    firstBuyTimestamp: 0,
    uniqueFunders: 0,
  });

  let sigs: Array<{ signature: string; blockTime?: number | null }> = [];
  try {
    const mint = new PublicKey(tokenAddress);
    sigs = await connection.getSignaturesForAddress(mint, { limit: 60 });
  } catch {
    return emptyResult();
  }

  if (!sigs || sigs.length === 0) return emptyResult();

  const batchSize = 5;
  const buyEvents: { buyer: string; timestamp: number; amount: number; signature: string; feePayer: string }[] = [];

  for (let i = 0; i < Math.min(sigs.length, 40); i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    await new Promise((r) => setTimeout(r, 400));

    let txs: Awaited<ReturnType<Connection["getParsedTransactions"]>> = [];
    try {
      txs = await connection.getParsedTransactions(
        batch.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );
    } catch {
      continue;
    }

    if (!txs) continue;

    for (const tx of txs) {
      if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) continue;

      const preBalances = tx.meta.preTokenBalances ?? [];
      const postBalances = tx.meta.postTokenBalances ?? [];

      for (let j = 0; j < postBalances.length; j++) {
        const post = postBalances[j];
        if (post.mint !== tokenAddress) continue;

        const pre = preBalances.find(
          (p) => p.accountIndex === post.accountIndex && p.mint === tokenAddress
        );
        const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
        const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
        const diff = postAmount - preAmount;

        if (diff > 0.000001 && post.owner && post.owner !== PUMP_FUN) {
          let feePayer = post.owner;
          try {
            const acctKeys = tx.transaction.message.accountKeys;
            for (const ak of acctKeys) {
              if ((ak as any).signer) { feePayer = (ak as any).pubkey?.toBase58?.() ?? post.owner; break; }
            }
          } catch (_) { /* fallback to owner */ }
          buyEvents.push({
            buyer: post.owner,
            timestamp: tx.blockTime * 1000,
            amount: diff,
            signature: tx.transaction.signatures[0],
            feePayer,
          });
        }
      }
    }
  }

  if (buyEvents.length === 0) {
    return {
      isBundled: false,
      confidence: "NONE",
      bundleGroups: [],
      totalBundleShare: 0,
      firstBuyTimestamp: 0,
      uniqueFunders: 0,
    };
  }

  buyEvents.sort((a, b) => a.timestamp - b.timestamp);
  const firstBuyTime = buyEvents[0].timestamp;
  const timeWindowMs = 5000; // 5 seconds for bundle detection
  const minWalletsInBundle = 3;

  const bundleGroups: BundleGroup[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < buyEvents.length; i++) {
    if (assigned.has(buyEvents[i].buyer)) continue;
    const event = buyEvents[i];
    const timeStart = event.timestamp;
    const timeEnd = timeStart + timeWindowMs;

    const windowEvents = buyEvents.filter(
      (e) => e.timestamp >= timeStart && e.timestamp <= timeEnd && !assigned.has(e.buyer)
    );

    const uniqueBuyers = new Map<string, number>();
    for (const e of windowEvents) {
      uniqueBuyers.set(e.buyer, (uniqueBuyers.get(e.buyer) ?? 0) + e.amount);
    }

    if (uniqueBuyers.size >= minWalletsInBundle) {
      const wallets = [...uniqueBuyers.keys()];
      const amounts = [...uniqueBuyers.values()];
      const totalAmount = amounts.reduce((s, a) => s + a, 0);

      const timestamps = windowEvents.map((e) => e.timestamp);
      const sameBlock = uniqueBuyers.size > 1 &&
        Math.max(...timestamps) - Math.min(...timestamps) < 2000;

      let commonFunder = findCommonFunder(windowEvents);

      bundleGroups.push({
        wallets: [...uniqueBuyers.keys()],
        buyTimestamp: timeStart,
        buyAmounts: amounts,
        sameBlock,
        commonFunder,
        tokenAmount: totalAmount,
      });

      for (const w of uniqueBuyers.keys()) assigned.add(w);
    }
  }

  const totalBundleTokens = bundleGroups.reduce((s, g) => s + g.tokenAmount, 0);
  const totalBundleShare = totalSupply > 0 ? totalBundleTokens / totalSupply : 0;
  const uniqueFunders = new Set(bundleGroups.map((g) => g.commonFunder).filter(Boolean)).size;

  let confidence: BundleDetectionResult["confidence"] = "NONE";
  if (bundleGroups.length > 0 && totalBundleShare > 0.1) {
    confidence = bundleGroups.length >= 3 ? "HIGH" : "MEDIUM";
  } else if (bundleGroups.length > 0) {
    confidence = "LOW";
  }

  return {
    isBundled: bundleGroups.length > 0,
    confidence,
    bundleGroups,
    totalBundleShare,
    firstBuyTimestamp: firstBuyTime,
    uniqueFunders,
  };
}
