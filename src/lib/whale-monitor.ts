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
  totalWalletsTracked: number;
}

const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WSOL = "So11111111111111111111111111111111111111112";

export async function analyzeWhales(
  connection: Connection,
  tokenAddress: string,
  priceUsd: number,
  whaleThresholdUsd = 500,
  lookbackHours = 1
): Promise<WhaleReport> {
  const mint = new PublicKey(tokenAddress);
  const lookbackTime = Date.now() - lookbackHours * 3600000;

  const sigs = await connection.getSignaturesForAddress(mint, { limit: 200 });

  const activities: WhaleActivity[] = [];
  const batchSize = 15;

  for (let i = 0; i < Math.min(sigs.length, 120); i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    await new Promise((r) => setTimeout(r, 150));

    const txs = await connection.getParsedTransactions(
      batch.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    for (const tx of txs) {
      if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) continue;
      const timestamp = tx.blockTime * 1000;
      if (timestamp < lookbackTime) continue;

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

        activities.push({
          address: owner,
          type: diff > 0 ? "entry" : "exit",
          amount: absDiff,
          valueUsd,
          timestamp,
          signature: tx.transaction.signatures[0],
        });
      }
    }
  }

  activities.sort((a, b) => b.timestamp - a.timestamp);

  const entering = activities.filter((a) => a.type === "entry");
  const exiting = activities.filter((a) => a.type === "exit");

  const uniqueEntering = new Set(entering.map((a) => a.address));
  const uniqueExiting = new Set(exiting.map((a) => a.address));
  const allWhaleAddresses = new Set(activities.map((a) => a.address));

  let totalIn = entering.reduce((s, a) => s + a.amount, 0);
  let totalOut = exiting.reduce((s, a) => s + a.amount, 0);
  const netAccumulation = totalIn - totalOut;
  const netAccumulationUsd = priceUsd > 0 ? netAccumulation * priceUsd : 0;

  let largestSell: WhaleActivity | null = null;
  for (const a of exiting) {
    if (!largestSell || a.valueUsd > largestSell.valueUsd) {
      largestSell = a;
    }
  }

  const totalWhaleVolume = totalIn + totalOut;

  // Bot detection: wallets that bought similar amounts at similar timestamps
  let botWallets = 0;
  const botCandidates = new Set<string>();

  const entryAddresses = entering.map((a) => a.address);
  for (let i = 0; i < entering.length; i++) {
    for (let j = i + 1; j < Math.min(entering.length, i + 20); j++) {
      if (
        Math.abs(entering[i].timestamp - entering[j].timestamp) < 3000 &&
        Math.abs(entering[i].amount - entering[j].amount) / Math.max(entering[i].amount, entering[j].amount) < 0.1
      ) {
        botCandidates.add(entering[i].address);
        botCandidates.add(entering[j].address);
      }
    }
  }
  botWallets = botCandidates.size;
  const botOwnershipPercent = allWhaleAddresses.size > 0
    ? (botWallets / allWhaleAddresses.size) * 100
    : 0;

  return {
    whalesEntering: uniqueEntering.size,
    whalesExiting: uniqueExiting.size,
    enteringDetails: entering.slice(0, 15),
    exitingDetails: exiting.slice(0, 15),
    largestSell,
    netAccumulation,
    netAccumulationUsd,
    totalWhaleVolume,
    botOwnershipPercent: Math.min(100, botOwnershipPercent),
    botWallets,
    totalWalletsTracked: allWhaleAddresses.size,
  };
}
