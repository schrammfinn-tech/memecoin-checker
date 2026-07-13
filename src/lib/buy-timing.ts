import { ComprehensiveRisk } from "./risk-engine";
import { WhaleReport } from "./whale-monitor";

export interface BuyTimingResult {
  tooLate: boolean;
  isRugged: boolean;
  label: "RUGGED" | "YES" | "NO" | "UNCERTAIN";
  confidence: number;
  reasons: string[];
}

export function assessBuyTiming(
  risk: ComprehensiveRisk,
  whaleReport?: WhaleReport | null
): BuyTimingResult {
  const reasons: string[] = [];
  const lp = risk.liquidityLock;
  const bndl = risk.bundleDetection;
  const dev = risk.devProfile;
  const bot = risk.botDetection;
  const sb = risk.scoreBreakdown;
  const holders = risk.holders || [];

  const walletHolders = holders.filter((h) => !h.isContract && !h.isDex);
  const totalSupply = risk.totalSupply || 1;

  // --- RUG CHECK (override everything) ---

  let ruggedReasons: string[] = [];
  let isRugged = false;

  if (lp) {
    if (lp.status === "NO_LP") {
      ruggedReasons.push("No liquidity pool — LP was removed or never existed");
      isRugged = true;
    } else if (lp.status === "ERROR") {
      ruggedReasons.push("Could not verify liquidity — pool may be gone");
      isRugged = true;
    } else if (lp.liquidityUsd <= 10) {
      ruggedReasons.push(`Liquidity is only $${lp.liquidityUsd.toFixed(2)} — effectively drained`);
      isRugged = true;
    } else if (lp.liquidityUsd <= 100) {
      ruggedReasons.push(`Liquidity is only $${lp.liquidityUsd.toFixed(0)} — dangerously low, likely rugged`);
      isRugged = true;
    }

    if (lp.priceChange24h <= -90) {
      ruggedReasons.push(`Price crashed ${Math.abs(lp.priceChange24h).toFixed(0)}% — coin is dead`);
      isRugged = true;
    } else if (lp.priceChange24h <= -80) {
      ruggedReasons.push(`Price dropped ${Math.abs(lp.priceChange24h).toFixed(0)}% — likely rugged`);
      isRugged = true;
    } else if (lp.priceUsd <= 0.00000001 && lp.liquidityUsd > 0 && lp.liquidityUsd <= 1000) {
      ruggedReasons.push("Price is effectively $0 — coin is dead");
      isRugged = true;
    }

    if (lp.volume24h <= 0 && lp.pairCreatedAt > 0) {
      const pairAgeHours = (Date.now() - lp.pairCreatedAt) / 3600000;
      if (pairAgeHours > 2) {
        ruggedReasons.push(`Zero volume for ${pairAgeHours.toFixed(0)}h old pair — coin is dead`);
        isRugged = true;
      }
    }

    if (lp.txns24hBuys === 0 && lp.txns24hSells === 0 && lp.pairCreatedAt > 0) {
      const pairAgeHours = (Date.now() - lp.pairCreatedAt) / 3600000;
      if (pairAgeHours > 4) {
        ruggedReasons.push("No transactions in 24h — trading has stopped");
        isRugged = true;
      }
    }
  } else {
    ruggedReasons.push("No liquidity data — pool likely non-existent");
    isRugged = true;
  }

  if (walletHolders.length <= 3 && bndl && bndl.firstBuyTimestamp > 0) {
    const ageHours = (Date.now() - bndl.firstBuyTimestamp) / 3600000;
    if (ageHours > 0.5) {
      ruggedReasons.push(`Only ${walletHolders.length} holders after ${ageHours.toFixed(0)}h — coin is dead`);
      isRugged = true;
    }
  } else if (walletHolders.length <= 5 && bndl && bndl.firstBuyTimestamp > 0) {
    const ageHours = (Date.now() - bndl.firstBuyTimestamp) / 3600000;
    if (ageHours > 2) {
      ruggedReasons.push(`Only ${walletHolders.length} holders after ${ageHours.toFixed(0)}h — likely rugged`);
      isRugged = true;
    }
  }

  const substantialHolders = walletHolders.filter((h) => h.share > 0.001);
  if (walletHolders.length > 0 && substantialHolders.length === 0 && walletHolders.length >= 3) {
    ruggedReasons.push("All holders have dust amounts — token has been dumped");
    isRugged = true;
  }

  if (dev?.isKnownRugger) {
    ruggedReasons.push("Developer is a known rugger — confirmed rug risk");
    isRugged = true;
  }

  if (totalSupply <= 0.00000001) {
    ruggedReasons.push("Supply is effectively zero — token destroyed");
    isRugged = true;
  }

  if (bot && bot.risk === "HIGH" && bot.botShareOfHolders > 0.5) {
    ruggedReasons.push(`Over 50% of holders are bots — token is likely dead/rugged`);
    isRugged = true;
  }

  if (isRugged) {
    return {
      tooLate: true,
      isRugged: true,
      label: "RUGGED",
      confidence: 90,
      reasons: ruggedReasons,
    };
  }

  // --- TOO LATE signals (add to score) ---
  let score = 0;

  if (lp) {
    if (lp.status === "NO_LP") { score += 30; }
    else if (lp.risk === "VERY_HIGH") { score += 18; reasons.push("LP risk is VERY HIGH"); }
    else if (lp.risk === "HIGH") { score += 10; reasons.push("LP risk is HIGH"); }

    if (lp.liquidityUsd > 100 && lp.liquidityUsd <= 500) {
      score += 8;
      reasons.push(`Low liquidity: $${lp.liquidityUsd.toFixed(0)}`);
    }

    if (lp.priceChange24h <= -60) {
      score += 20;
      reasons.push(`Price crashed ${Math.abs(lp.priceChange24h).toFixed(0)}% — likely dump in progress`);
    } else if (lp.priceChange24h <= -40) {
      score += 12;
      reasons.push(`Price dropped ${Math.abs(lp.priceChange24h).toFixed(0)}% — significant decline`);
    } else if (lp.priceChange24h <= -20) {
      score += 6;
      reasons.push(`Price down ${Math.abs(lp.priceChange24h).toFixed(0)}%`);
    }

    if (lp.priceUsd > 0 && lp.priceUsd < 0.0000001) {
      score += 15;
      reasons.push("Price is near zero — coin may be dead");
    }

    if (lp.volume24h <= 0 && lp.pairCreatedAt > 0) {
      score += 8;
      reasons.push("Zero 24h volume — no trading activity");
    } else if (lp.volume24h < 50) {
      score += 4;
      reasons.push("Very low 24h volume");
    }
  }

  if (bndl?.isBundled) {
    const share = bndl.totalBundleShare;
    if (share > 0.3) { score += 20; reasons.push("Bundled launch — 30%+ supply went to insiders"); }
    else if (share > 0.15) { score += 12; reasons.push("Bundled launch — 15%+ supply pre-distributed"); }
    else { score += 5; reasons.push("Possible bundled launch detected"); }
  }

  if (dev?.isKnownRugger) {
    score += 25;
    reasons.push("Developer is a known rugger — likely to dump");
  } else if (dev && dev.rugRate > 0.5) {
    score += 18;
    reasons.push(`Developer has ${(dev.rugRate * 100).toFixed(0)}% rug rate`);
  } else if (dev && dev.rugRate > 0.3) {
    score += 10;
    reasons.push(`Developer has ${(dev.rugRate * 100).toFixed(0)}% rug rate`);
  }

  if (sb.holderConcentration > 15) {
    score += 10;
    reasons.push("High holder concentration — top wallets can dump");
  } else if (sb.holderConcentration > 8) {
    score += 5;
  }

  if (bot && bot.risk === "HIGH") {
    score += 10;
    reasons.push(`${bot.estimatedBots} bots detected — inflated metrics, likely dump`);
  } else if (bot && bot.risk === "MEDIUM") {
    score += 5;
  }

  if (sb.clusteringScore > 12) {
    score += 8;
    reasons.push("Multiple wallet clusters — coordinated wallets likely to exit together");
  }

  // --- Whale exit signals ---
  if (whaleReport) {
    const tf1h = whaleReport.timeframes["1h"];
    const tfall = whaleReport.timeframes["all"];
    if (tf1h.whalesExiting > tf1h.whalesEntering * 2) {
      score += 15;
      reasons.push("Whales exiting 2x faster than entering — distribution phase");
    } else if (tf1h.whalesExiting > tf1h.whalesEntering) {
      score += 8;
      reasons.push("More whales exiting than entering");
    }
    if (tfall.netAccumulationUsd < -5000) {
      score += 10;
      reasons.push("Heavy net whale outflow — smart money leaving");
    }
  }

  // --- NOT TOO LATE signals (subtract from score) ---

  if (risk.overallRisk === "LOW") {
    score -= 12;
    reasons.push("Overall risk is LOW");
  }

  if (bndl && !bndl.isBundled && bndl.confidence === "NONE") {
    score -= 10;
    reasons.push("Clean launch — no bundle detected");
  }

  if (lp && lp.status === "BURNED" && lp.risk === "SAFE") {
    score -= 12;
    reasons.push("LP burned and safe");
  }

  if (!dev || dev.rugRate < 0.1) {
    score -= 5;
  }

  if (walletHolders.length >= 50 && sb.holderConcentration < 8) {
    score -= 5;
    reasons.push("Well-distributed across 50+ wallets");
  }

  if (whaleReport) {
    const tf1h = whaleReport.timeframes["1h"];
    if (tf1h.whalesEntering > tf1h.whalesExiting * 2 && tf1h.netAccumulationUsd > 5000) {
      score -= 12;
      reasons.push("Whales accumulating — strong entry signal");
    } else if (tf1h.whalesEntering > tf1h.whalesExiting && tf1h.netAccumulationUsd > 0) {
      score -= 6;
      reasons.push("Whales entering — net positive flow");
    }
  }

  let label: BuyTimingResult["label"];
  if (score >= 15) {
    label = "YES";
  } else if (score >= 6) {
    label = "UNCERTAIN";
  } else {
    label = "NO";
  }

  const confidence = Math.min(100, Math.max(0, Math.abs(score) * 3));

  return {
    tooLate: label === "YES",
    isRugged: false,
    label,
    confidence,
    reasons,
  };
}
