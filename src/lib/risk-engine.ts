import { Connection, PublicKey } from "@solana/web3.js";
import { HeliusClient, TokenOnChainAnalysis, HolderInfo } from "./helius";
import { createConnection } from "./solana";
import { buildTransferGraph, findClusters, computeClusterShare, WalletCluster } from "./clustering";
import { detectBundledLaunch, BundleDetectionResult } from "./bundle-detector";
import { getDevProfile, DevProfile } from "./dev-history";
import { analyzeLiquidityLock, LiquidityLockResult } from "./liquidity";
import { scanSocials, SocialResult } from "./social-scanner";
import { detectBots, BotDetectResult } from "./bot-detector";

export interface ComprehensiveRisk {
  overallRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  scoreBreakdown: {
    holderConcentration: number;
    clusteringScore: number;
    bundleScore: number;
    liquidityScore: number;
    devReputationScore: number;
    botScore: number;
    socialScore: number;
  };
  holders: HolderInfo[];
  clusters: WalletCluster[];
  bundleDetection: BundleDetectionResult | null;
  botDetection: BotDetectResult | null;
  liquidityLock: LiquidityLockResult | null;
  devProfile: DevProfile | null;
  socialResult: SocialResult | null;
  supplyStats: any;
  scores: any;
  totalSupply: number;
}

export async function comprehensiveAnalyze(
  tokenAddress: string,
  helius: HeliusClient,
  rpcUrl: string
): Promise<ComprehensiveRisk> {
  const connection = createConnection(rpcUrl);

  const onChain = await helius.analyzeToken(tokenAddress);
  const holders = onChain.holders;
  const totalSupply = onChain.totalSupply || holders.reduce((s, h) => s + h.amount, 0);

  const botResult = detectBots(holders, totalSupply);

  // Run heavy RPC features sequentially to avoid rate limits
  let clustersRaw: any = { status: "rejected", reason: "skipped" };
  let bundleResult: any = { status: "rejected", reason: "skipped" };
  let devProfile: any = { status: "rejected", reason: "skipped" };
  let liquidityResult: any = { status: "rejected", reason: "skipped" };
  let socialResult: any = { status: "rejected", reason: "skipped" };

  // 1. First do light operations
  try {
    socialResult = await Promise.allSettled([scanSocials(tokenAddress)]).then(r => r[0]);
  } catch(e) { /* skip */ }

  // 2. Then clustering (light)
  try {
    const { edges, nodeShares } = await buildTransferGraph(connection, tokenAddress, 100);
    const clustersFound = findClusters(edges, nodeShares);
    clustersRaw = { status: "fulfilled", value: computeClusterShare(clustersFound, holders, totalSupply) };
  } catch(e) { /* skip */ }

  // 3. Bundle detection
  try {
    const b = await detectBundledLaunch(connection, tokenAddress, totalSupply);
    bundleResult = { status: "fulfilled", value: b };
  } catch(e) { /* skip */ }

  // 4. Dev profile
  try {
    await new Promise(r => setTimeout(r, 300));
    const d = await getDevProfile(connection, tokenAddress);
    devProfile = { status: "fulfilled", value: d };
    // Re-run social scan with deployer address if found
    if (d?.deployerAddress && d.deployerAddress !== "unknown") {
      try {
        const s2 = await scanSocials(tokenAddress, d.deployerAddress);
        socialResult = { status: "fulfilled", value: s2 };
      } catch(e) { /* keep original */ }
    }
  } catch(e) { /* skip */ }

  // 5. Liquidity
  try {
    await new Promise(r => setTimeout(r, 300));
    let deployer = "unknown";
    if (holders.length > 0) {
      const wallet = holders.find((h) => h.owner !== "unknown" && !h.isDex && !h.isContract);
      deployer = wallet?.owner ?? "unknown";
    }
    const l = await analyzeLiquidityLock(connection, tokenAddress, deployer);
    liquidityResult = { status: "fulfilled", value: l };
  } catch(e) { /* skip */ }

  const clusters: WalletCluster[] = clustersRaw.status === "fulfilled" ? clustersRaw.value : [];
  const bundleResultVal = bundleResult.status === "fulfilled" ? bundleResult.value : null;
  const devProfileVal = devProfile.status === "fulfilled" ? devProfile.value : null;
  const liquidityResultVal = liquidityResult.status === "fulfilled" ? liquidityResult.value : null;
  const socialResultVal: SocialResult | null = socialResult.status === "fulfilled" ? socialResult.value : null;

  const walletHolders = holders.filter((h) => !h.isContract && !h.isDex);
  const totalHolderShare = walletHolders.reduce((s, h) => s + h.share, 0);
  const top10WalletShare = walletHolders.slice(0, 10).reduce((s, h) => s + h.share, 0);
  const top20WalletShare = walletHolders.slice(0, 20).reduce((s, h) => s + h.share, 0);
  const top3WalletShare = walletHolders.slice(0, 3).reduce((s, h) => s + h.share, 0);

  // 1. Holder Concentration Score (0-25 points, higher = worse)
  let holderScore = 0;
  if (top3WalletShare > 0.3) holderScore += 10;
  else if (top3WalletShare > 0.15) holderScore += 5;
  if (top10WalletShare > 0.5) holderScore += 10;
  else if (top10WalletShare > 0.3) holderScore += 5;
  if (top20WalletShare > 0.7) holderScore += 5;
  else if (top20WalletShare > 0.5) holderScore += 2;
  const holderConcentrationScore = Math.min(25, holderScore);

  // 2. Clustering Score (0-20 points)
  let clusterScore = 0;
  const significantClusters = clusters.filter((c) => c.wallets.size >= 3 && c.totalShare > 0.02);
  const totalClusterShare = significantClusters.reduce((s, c) => s + c.totalShare, 0);
  if (totalClusterShare > 0.3) clusterScore += 10;
  else if (totalClusterShare > 0.15) clusterScore += 5;
  if (significantClusters.length >= 3) clusterScore += 5;
  else if (significantClusters.length >= 1) clusterScore += 2;
  const maxClusterShare = significantClusters.length > 0
    ? Math.max(...significantClusters.map((c) => c.totalShare))
    : 0;
  if (maxClusterShare > 0.2) clusterScore += 5;
  else if (maxClusterShare > 0.1) clusterScore += 2;
  const clusteringScore = Math.min(20, clusterScore);

  // 3. Bundle Score (0-20 points)
  let bundleScore = 0;
  if (bundleResultVal) {
    if (bundleResultVal.totalBundleShare > 0.3) bundleScore += 12;
    else if (bundleResultVal.totalBundleShare > 0.15) bundleScore += 7;
    else if (bundleResultVal.totalBundleShare > 0.05) bundleScore += 3;
    if (bundleResultVal.bundleGroups.length >= 3) bundleScore += 5;
    else if (bundleResultVal.bundleGroups.length >= 1) bundleScore += 3;
    if (bundleResultVal.confidence === "HIGH") bundleScore += 3;
  }
  const bundleDetectionScore = Math.min(20, bundleScore);

  // 4. Liquidity Score (0-15 points)
  let liquidityScore = 0;
  if (liquidityResultVal) {
    switch (liquidityResultVal.risk) {
      case "VERY_HIGH": liquidityScore = 15; break;
      case "HIGH": liquidityScore = 10; break;
      case "MODERATE": liquidityScore = 5; break;
      case "SAFE": liquidityScore = 0; break;
    }
    if (liquidityResultVal.status === "NO_LP") liquidityScore = 15;
    if (liquidityResultVal.deployerHoldsLP) liquidityScore += 3;
  }
  const liquidityLockScore = Math.min(15, liquidityScore);

  // 5. Developer Reputation Score (0-10 points)
  let devScore = 0;
  if (devProfileVal) {
    if (devProfileVal.isKnownRugger) devScore = 10;
    else if (devProfileVal.rugRate > 0.3) devScore = 7;
    else if (devProfileVal.rugRate > 0.1) devScore = 4;
    if (devProfileVal.avgTokenLifespanHours < 1 && devProfileVal.totalTokensLaunched > 0) devScore += 3;
    if (devProfileVal.totalTokensLaunched >= 10) devScore += 2;
  }
  const devReputationScore = Math.min(10, devScore);

  // 6. Bot Score (0-10 points)
  const botDetectionScore = botResult.riskScore;

  // 7. Social Score (0-10 points)
  let socialScore = 0;
  if (socialResultVal) {
    if (socialResultVal.redFlags.length >= 3) socialScore = 10;
    else if (socialResultVal.redFlags.length >= 2) socialScore = 7;
    else if (socialResultVal.redFlags.length >= 1) socialScore = 4;
    if (socialResultVal.twitter?.isSuspicious) socialScore += 2;
    if (socialResultVal.telegram?.isSuspicious) socialScore += 2;
  }
  const socialMediaScore = Math.min(10, socialScore);

  const totalScore = holderConcentrationScore + clusteringScore + bundleDetectionScore +
    liquidityLockScore + devReputationScore + botDetectionScore + socialMediaScore;

  let overallRisk: ComprehensiveRisk["overallRisk"] = "LOW";
  if (totalScore >= 65) overallRisk = "CRITICAL";
  else if (totalScore >= 45) overallRisk = "HIGH";
  else if (totalScore >= 22) overallRisk = "MEDIUM";

  return {
    overallRisk,
    scoreBreakdown: {
      holderConcentration: holderConcentrationScore,
      clusteringScore,
      bundleScore: bundleDetectionScore,
      liquidityScore: liquidityLockScore,
      devReputationScore,
      botScore: botDetectionScore,
      socialScore: socialMediaScore,
    },
    holders,
    clusters: significantClusters,
    bundleDetection: bundleResultVal,
    botDetection: botResult,
    liquidityLock: liquidityResultVal,
    devProfile: devProfileVal,
    socialResult: socialResultVal,
    supplyStats: onChain.supplyStats,
    scores: onChain.scores,
    totalSupply,
  };
}

export function formatRiskExplanation(result: ComprehensiveRisk): string {
  const lines: string[] = [];
  const sb = result.scoreBreakdown;

  lines.push("");
  lines.push(`OVERALL: ${result.overallRisk}`);
  lines.push(`  Holder Concentration: ${sb.holderConcentration}/25`);
  lines.push(`  Wallet Clustering:    ${sb.clusteringScore}/20`);
  lines.push(`  Bundle Detection:     ${sb.bundleScore}/20`);
  lines.push(`  Liquidity Lock:       ${sb.liquidityScore}/15`);
  lines.push(`  Dev Reputation:       ${sb.devReputationScore}/10`);
  lines.push(`  Bot Activity:         ${sb.botScore}/10`);

  if (result.liquidityLock) {
    lines.push("");
    lines.push(`LP Status: ${result.liquidityLock.status} (${result.liquidityLock.risk})`);
    if (result.liquidityLock.burnedPercent > 0) {
      lines.push(`  Burned: ${(result.liquidityLock.burnedPercent * 100).toFixed(1)}%`);
    }
  }

  if (result.devProfile) {
    lines.push("");
    lines.push(`Dev: ${result.devProfile.deployerAddress.slice(0, 12)}...`);
    lines.push(`  Tokens launched: ${result.devProfile.totalTokensLaunched}`);
    lines.push(`  Rug rate: ${(result.devProfile.rugRate * 100).toFixed(0)}%`);
    lines.push(`  Known rugger: ${result.devProfile.isKnownRugger}`);
  }

  if (result.clusters.length > 0) {
    lines.push("");
    lines.push(`Clusters found: ${result.clusters.length}`);
    for (const c of result.clusters.slice(0, 5)) {
      lines.push(`  ${c.wallets.size} wallets, ${(c.totalShare * 100).toFixed(1)}%`);
    }
  }

  return lines.join("\n");
}
