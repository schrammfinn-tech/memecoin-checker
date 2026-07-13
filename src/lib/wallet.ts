import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { HeliusClient, HolderInfo, TokenOnChainAnalysis } from "./helius";
import { createConnection, getSignaturesForAddress } from "./solana";

export interface SniperResult {
  address: string;
  tokenAddress: string;
  buyTimestamp: number;
  buyAmount: number;
  timeToBuyMs: number;
  roi: number;
  share: number;
}

export interface RiskAssessment {
  overallRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  decentralizationScore: number;
  bundleRisk: "LOW" | "MEDIUM" | "HIGH";
  topHolderConcentration: number;
  sniperActivity: "LOW" | "MEDIUM" | "HIGH";
  snipers: SniperResult[];
  supplyDistribution: {
    dexShare: number;
    contractShare: number;
    top10Share: number;
    walletTop10Share: number;
  };
  giniIndex: number;
  nakamotoCoefficient: number;
}

export interface FullTokenAnalysis {
  token: string;
  totalSupply: number;
  holders: HolderInfo[];
  riskAssessment: RiskAssessment;
}

export async function fullAnalyze(
  tokenAddress: string,
  helius: HeliusClient,
  rpcUrl: string
): Promise<FullTokenAnalysis> {
  const connection = createConnection(rpcUrl);

  const onChain = await helius.analyzeToken(tokenAddress);

  const topWallets = onChain.holders
    .filter((h) => !h.isContract && !h.isDex)
    .slice(0, 5);

  const snipers = await detectSnipers(connection, tokenAddress, topWallets);

  const sniperCount = snipers.length;
  const sniperActivity: RiskAssessment["sniperActivity"] =
    sniperCount >= 5 ? "HIGH" : sniperCount >= 2 ? "MEDIUM" : "LOW";

  const riskScore =
    (onChain.bundleRisk === "HIGH" ? 3 : onChain.bundleRisk === "MEDIUM" ? 1.5 : 0) +
    (sniperActivity === "HIGH" ? 3 : sniperActivity === "MEDIUM" ? 1.5 : 0) +
    (onChain.supplyStats.walletTop10Share > 0.5 ? 3 : onChain.supplyStats.walletTop10Share > 0.3 ? 1.5 : 0) +
    (onChain.scores.decentralizationScore < 40 ? 2 : onChain.scores.decentralizationScore < 60 ? 1 : 0);

  let overallRisk: RiskAssessment["overallRisk"] = "LOW";
  if (riskScore >= 6) overallRisk = "CRITICAL";
  else if (riskScore >= 4) overallRisk = "HIGH";
  else if (riskScore >= 2) overallRisk = "MEDIUM";

  return {
    token: tokenAddress,
    totalSupply: onChain.totalSupply,
    holders: onChain.holders,
    riskAssessment: {
      overallRisk,
      decentralizationScore: onChain.scores.decentralizationScore,
      bundleRisk: onChain.bundleRisk,
      topHolderConcentration: onChain.supplyStats.walletTop10Share,
      sniperActivity,
      snipers,
      supplyDistribution: {
        dexShare: onChain.supplyStats.dexShare,
        contractShare: onChain.supplyStats.contractShare,
        top10Share: onChain.supplyStats.top10Share,
        walletTop10Share: onChain.supplyStats.walletTop10Share,
      },
      giniIndex: onChain.scores.giniIndex,
      nakamotoCoefficient: onChain.scores.nakamotoCoefficient,
    },
  };
}

export async function detectSnipers(
  connection: Connection,
  tokenAddress: string,
  wallets: HolderInfo[],
  snipingThresholdMs = 30000
): Promise<SniperResult[]> {
  const results: SniperResult[] = [];
  const mintPubkey = new PublicKey(tokenAddress);

  let firstTxTimestamp = Infinity;
  try {
    const sigs = await connection.getSignaturesForAddress(mintPubkey, { limit: 1 });
    if (sigs.length > 0) {
      const tx = await connection.getParsedTransaction(sigs[0].signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.blockTime) firstTxTimestamp = tx.blockTime * 1000;
    }
  } catch { /* fallback */ }

  if (firstTxTimestamp === Infinity) {
    firstTxTimestamp = Date.now() - 3600000;
  }

  for (const wallet of wallets) {
    try {
      await new Promise((r) => setTimeout(r, 200)); // rate limit

      const pubkey = new PublicKey(wallet.owner);
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 10 });
      const validSigs = sigs.filter((s) => s.err === null);
      if (validSigs.length === 0) continue;

      const txs = await connection.getParsedTransactions(
        validSigs.slice(0, 2).map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );

      let earliestBuyTime = Infinity;
      let totalBuyTokens = 0;

      for (const tx of txs) {
        if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) continue;

        const preBalances = tx.meta.preTokenBalances ?? [];
        const postBalances = tx.meta.postTokenBalances ?? [];

        for (let i = 0; i < postBalances.length; i++) {
          const post = postBalances[i];
          if (post.mint !== tokenAddress) continue;

          const pre = preBalances.find(
            (p) => p.accountIndex === post.accountIndex && p.mint === tokenAddress
          );

          const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
          const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
          const diff = postAmount - preAmount;

          if (diff > 0 && post.owner === wallet.owner) {
            const blockTime = tx.blockTime * 1000;
            if (blockTime < earliestBuyTime) {
              earliestBuyTime = blockTime;
            }
            totalBuyTokens += diff;
          }
        }
      }

      if (earliestBuyTime !== Infinity) {
        const timeToBuyMs = earliestBuyTime - firstTxTimestamp;

        if (timeToBuyMs <= snipingThresholdMs) {
          const pricePerToken = totalBuyTokens > 0 ? 0 : 0; // Would need DEX pair data for accurate pricing
          const roi = 0; // Simplified - needs pair price history

          results.push({
            address: wallet.owner,
            tokenAddress,
            buyTimestamp: earliestBuyTime,
            buyAmount: totalBuyTokens,
            timeToBuyMs,
            roi,
            share: wallet.share,
          });
        }
      }
    } catch {
      // skip
    }
  }

  return results.sort((a, b) => a.timeToBuyMs - b.timeToBuyMs);
}
