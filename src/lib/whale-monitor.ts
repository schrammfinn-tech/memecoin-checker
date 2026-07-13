import { Connection, PublicKey } from "@solana/web3.js";

export interface WhaleActivity {
  address: string;
  type: "entry" | "exit";
  amount: number;
  valueUsd: number;
  timestamp: number;
  signature: string;
}

export interface WhaleReport {
  timeframes: {
    "1h": WhaleTimeframe;
    "2h": WhaleTimeframe;
    "3h": WhaleTimeframe;
    "all": WhaleTimeframe;
  };
  totalWalletsTracked: number;
}

export interface WhaleTimeframe {
  whalesEntering: number;
  whalesExiting: number;
  enteringDetails: WhaleActivity[];
  exitingDetails: WhaleActivity[];
  largestSell: WhaleActivity | null;
  netAccumulation: number;
  netAccumulationUsd: number;
  totalWhaleVolume: number;
  botOwnershipPercent: number;
  botWallets: number;
}

const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WSOL = "So11111111111111111111111111111111111111112";

export async function analyzeWhales(
  connection: Connection,
  tokenAddress: string,
  priceUsd: number,
  whaleThresholdUsd = 500
): Promise<WhaleReport> {
  const mint = new PublicKey(tokenAddress);
  const now = Date.now();

  const sigs = await connection.getSignaturesForAddress(mint, { limit: 50 });

  const allActivities: WhaleActivity[] = [];
  const batchSize = 3;

  for (let i = 0; i < Math.min(sigs.length, 30); i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const txs = await connection.getParsedTransactions(
        batch.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );

      for (const tx of txs) {
        if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) continue;
        const timestamp = tx.blockTime * 1000;

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
          const absDiff = Math.abs(diff);

          const valueUsd = priceUsd > 0 ? absDiff * priceUsd : 0;
          if (valueUsd < whaleThresholdUsd || absDiff < 0.000001) continue;

          const owner = post.owner ?? pre?.owner ?? "unknown";
          if (owner === PUMP_FUN || owner === "unknown" || owner.length > 44) continue;

          allActivities.push({
            address: owner,
            type: diff > 0 ? "entry" : "exit",
            amount: absDiff,
            valueUsd,
            timestamp,
            signature: tx.transaction.signatures[0],
          });
        }
      }
    } catch {}
  }

  allActivities.sort((a, b) => b.timestamp - a.timestamp);

  const computeTimeframe = (hours: number): WhaleTimeframe => {
    const cutoff = now - hours * 3600000;
    const relevant = allActivities.filter((a) => a.timestamp >= cutoff);

    const entering = relevant.filter((a) => a.type === "entry");
    const exiting = relevant.filter((a) => a.type === "exit");

    const uniqueEntering = new Set(entering.map((a) => a.address));
    const uniqueExiting = new Set(exiting.map((a) => a.address));

    const totalIn = entering.reduce((s, a) => s + a.amount, 0);
    const totalOut = exiting.reduce((s, a) => s + a.amount, 0);

    let largestSell: WhaleActivity | null = null;
    for (const a of exiting) {
      if (!largestSell || a.valueUsd > largestSell.valueUsd) largestSell = a;
    }

    const botEntries = entering.filter((a, i) => {
      for (let j = i + 1; j < Math.min(entering.length, i + 10); j++) {
        if (Math.abs(a.timestamp - entering[j].timestamp) < 3000 &&
            Math.abs(a.amount - entering[j].amount) / Math.max(a.amount, entering[j].amount, 0.001) < 0.1) {
          return true;
        }
      }
      return false;
    });
    const botWallets = new Set(botEntries.map((a) => a.address)).size;
    const allAddresses = new Set(relevant.map((a) => a.address));

    return {
      whalesEntering: uniqueEntering.size,
      whalesExiting: uniqueExiting.size,
      enteringDetails: entering.slice(0, 10),
      exitingDetails: exiting.slice(0, 10),
      largestSell,
      netAccumulation: totalIn - totalOut,
      netAccumulationUsd: priceUsd > 0 ? (totalIn - totalOut) * priceUsd : 0,
      totalWhaleVolume: totalIn + totalOut,
      botOwnershipPercent: allAddresses.size > 0 ? (botWallets / allAddresses.size) * 100 : 0,
      botWallets,
    };
  };

  const allAddresses = new Set(allActivities.map((a) => a.address));

  return {
    timeframes: {
      "1h": computeTimeframe(1),
      "2h": computeTimeframe(2),
      "3h": computeTimeframe(3),
      "all": computeTimeframe(72), // up to 3 days
    },
    totalWalletsTracked: allAddresses.size,
  };
}
