import { HolderInfo } from "./helius";

export interface BotDetectResult {
  totalHolders: number;
  walletHolders: number;
  estimatedBots: number;
  botWalletsList: string[];
  dustWallets: number;
  botShareOfHolders: number;
  botShareOfSupply: number;
  risk: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  riskScore: number;
  reasons: string[];
}

export function detectBots(holders: HolderInfo[], totalSupply: number): BotDetectResult {
  const walletHolders = holders.filter((h) => !h.isContract && !h.isDex);
  const reasons: string[] = [];

  const balanceGroups = new Map<string, { wallets: string[]; amount: number }>();
  for (const h of walletHolders) {
    const rounded = (Math.round(h.amount / (totalSupply * 0.00001)) * (totalSupply * 0.00001)).toFixed(12);
    const key = rounded;
    if (!balanceGroups.has(key)) balanceGroups.set(key, { wallets: [], amount: h.amount });
    balanceGroups.get(key)!.wallets.push(h.owner);
  }

  let estimatedBots = 0;
  const botWalletsSet = new Set<string>();

  for (const [, group] of balanceGroups) {
    if (group.wallets.length >= 5) {
      for (const w of group.wallets) botWalletsSet.add(w);
      estimatedBots += group.wallets.length;
    }
  }

  if (estimatedBots >= 10) {
    reasons.push(`${estimatedBots} wallets share near-identical balances — likely bot farm`);
  }

  let dustWallets = 0;
  for (const h of walletHolders) {
    if (h.amount > 0 && h.amount < totalSupply * 0.0001 && h.amount > 0) {
      dustWallets++;
    }
  }

  if (dustWallets >= 20) {
    reasons.push(`${dustWallets} dust wallets (micro balances) — possible Sybil distribution`);
    for (const h of walletHolders) {
      if (h.amount > 0 && h.amount < totalSupply * 0.0001) {
        botWalletsSet.add(h.owner);
      }
    }
    estimatedBots = Math.max(estimatedBots, dustWallets);
  }

  const botWalletsList = [...botWalletsSet];
  const uniqueBotCount = botWalletsList.length;
  const botShareOfHolders = walletHolders.length > 0 ? uniqueBotCount / walletHolders.length : 0;
  const botShareOfSupply = totalSupply > 0
    ? walletHolders.filter((h) => botWalletsSet.has(h.owner)).reduce((s, h) => s + h.amount, 0) / totalSupply
    : 0;

  let risk: BotDetectResult["risk"] = "NONE";
  let riskScore = 0;

  if (botShareOfHolders > 0.3) {
    risk = "HIGH";
    riskScore = 10;
    reasons.push(`${(botShareOfHolders * 100).toFixed(0)}% of holders appear to be bots`);
  } else if (botShareOfHolders > 0.15) {
    risk = "MEDIUM";
    riskScore = 7;
  } else if (uniqueBotCount >= 5) {
    risk = "LOW";
    riskScore = 4;
  }

  if (botShareOfSupply > 0.15) {
    risk = "HIGH";
    riskScore = Math.max(riskScore, 10);
    reasons.push(`Bots hold ${(botShareOfSupply * 100).toFixed(1)}% of supply`);
  } else if (botShareOfSupply > 0.05) {
    riskScore = Math.max(riskScore, 7);
    if (risk === "NONE" || risk === "LOW") risk = "MEDIUM";
  }

  if (estimatedBots >= 20) {
    riskScore = Math.max(riskScore, 10);
    risk = "HIGH";
  }

  return {
    totalHolders: holders.length,
    walletHolders: walletHolders.length,
    estimatedBots: uniqueBotCount,
    botWalletsList,
    dustWallets,
    botShareOfHolders,
    botShareOfSupply,
    risk,
    riskScore: Math.min(10, riskScore),
    reasons,
  };
}
