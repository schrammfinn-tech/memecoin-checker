import chalk from "chalk";
import { FullTokenAnalysis, SniperResult, RiskAssessment } from "./wallet";
import { HolderInfo, TokenOnChainAnalysis } from "./helius";

export function formatAnalysis(result: FullTokenAnalysis): string {
  const risk = result.riskAssessment;
  const riskColor =
    risk.overallRisk === "CRITICAL" ? chalk.bgRed.white :
    risk.overallRisk === "HIGH" ? chalk.red :
    risk.overallRisk === "MEDIUM" ? chalk.yellow :
    chalk.green;

  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold.cyan("══════════════════════════════════════════════"));
  lines.push(chalk.bold.cyan("  MEMECOIN CHECKER - Token Analysis"));
  lines.push(chalk.bold.cyan("══════════════════════════════════════════════"));
  lines.push("");
  lines.push(`${chalk.gray("Token:")}  ${chalk.white(result.token)}`);
  lines.push(`${chalk.gray("Supply:")} ${chalk.white(formatNumber(result.totalSupply))}`);
  lines.push("");

  lines.push(chalk.bold("RISK ASSESSMENT"));
  lines.push(`${"─".repeat(46)}`);
  lines.push(`  ${chalk.gray("Overall Risk:")}         ${riskColor(` ${risk.overallRisk} `)}`);
  lines.push(`  ${chalk.gray("Decentralization Score:")} ${formatScore(risk.decentralizationScore)}`);
  lines.push(`  ${chalk.gray("Bundle Risk:")}           ${formatRisk(risk.bundleRisk)}`);
  lines.push(`  ${chalk.gray("Sniper Activity:")}       ${formatRisk(risk.sniperActivity)}`);
  lines.push(`  ${chalk.gray("Top-10 Wallet Share:")}   ${chalk.white((risk.topHolderConcentration * 100).toFixed(1) + "%")}`);
  lines.push("");

  lines.push(chalk.bold("SUPPLY DISTRIBUTION"));
  lines.push(`${"─".repeat(46)}`);
  const sd = risk.supplyDistribution;
  lines.push(`  DEX Pools:    ${bar(sd.dexShare)}  ${chalk.white((sd.dexShare * 100).toFixed(1) + "%")}`);
  lines.push(`  Contracts:    ${bar(sd.contractShare)}  ${chalk.white((sd.contractShare * 100).toFixed(1) + "%")}`);
  lines.push(`  Top 10 Total: ${bar(sd.top10Share)}  ${chalk.white((sd.top10Share * 100).toFixed(1) + "%")}`);
  lines.push(`  Top 10 Wallet:${bar(sd.walletTop10Share)}  ${chalk.white((sd.walletTop10Share * 100).toFixed(1) + "%")}`);
  lines.push("");

  lines.push(chalk.bold("DECENTRALIZATION METRICS"));
  lines.push(`${"─".repeat(46)}`);
  lines.push(`  ${chalk.gray("Decentralization Score:")}  ${formatScore(risk.decentralizationScore)}`);
  lines.push(`  ${chalk.gray("Gini Index:")}             ${chalk.white(risk.giniIndex.toFixed(4))} ${chalk.gray("(0=equal)")}`);
  lines.push(`  ${chalk.gray("Nakamoto Coeff:")}        ${chalk.white(String(risk.nakamotoCoefficient))} ${chalk.gray("(wallets for 50%)")}`);
  lines.push("");

  if (risk.snipers.length > 0) {
    lines.push(chalk.bold.red("DETECTED SNIPERS"));
    lines.push(`${"─".repeat(46)}`);
    for (const s of risk.snipers.slice(0, 10)) {
      const timeStr =
        s.timeToBuyMs < 1000
          ? chalk.red(`${s.timeToBuyMs}ms`)
          : chalk.yellow(`${(s.timeToBuyMs / 1000).toFixed(1)}s`);
      lines.push(`  ${chalk.yellow(s.address.slice(0, 16) + "...")} bought in ${timeStr} after launch`);
      lines.push(`    ${chalk.gray("Share:")} ${chalk.white((s.share * 100).toFixed(2) + "%")}  ${chalk.gray("Amount:")} ${chalk.white(formatNumber(s.buyAmount))}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatHolders(holders: HolderInfo[], limit = 30): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("TOP HOLDERS"));
  lines.push(`${"─".repeat(90)}`);
  lines.push(`  ${chalk.gray("#".padEnd(4))} ${chalk.gray("Owner".padEnd(48))} ${chalk.gray("Share".padEnd(10))} ${chalk.gray("Amount".padEnd(16))} ${chalk.gray("Type")}`);
  lines.push(`  ${"─".repeat(88)}`);

  const display = holders.slice(0, limit);
  for (let i = 0; i < display.length; i++) {
    const h = display[i];
    const addr = h.owner.slice(0, 20) + "..." + h.owner.slice(-8);
    const share = (h.share * 100).toFixed(2) + "%";
    const amount = formatNumber(h.amount);
    const type =
      h.isDex ? chalk.blue(" DEX     ") :
      h.isContract ? chalk.magenta(" CONTRACT") :
      h.knownLabel ? chalk.gray(` ${h.knownLabel.slice(0, 9)}`) :
      chalk.green(" WALLET  ");

    lines.push(`  ${String(i + 1).padEnd(4)} ${addr.padEnd(48)} ${share.padEnd(10)} ${amount.padEnd(16)} ${type}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function formatSniperResults(snipers: SniperResult[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold.red("SNIPER DETECTION RESULTS"));
  lines.push(`${"─".repeat(60)}`);

  if (snipers.length === 0) {
    lines.push(`  ${chalk.green("No snipers detected")}`);
  } else {
    for (const s of snipers) {
      const timeStr =
        s.timeToBuyMs < 1000
          ? chalk.red(`${s.timeToBuyMs}ms`)
          : chalk.yellow(`${(s.timeToBuyMs / 1000).toFixed(1)}s`);

      lines.push(
        `  ${chalk.white(s.address.slice(0, 16) + "...")} - bought in ${timeStr} after launch`
      );
      lines.push(
        `    ${chalk.gray("Share:")} ${chalk.white((s.share * 100).toFixed(2) + "%")}  ${chalk.gray("Amount:")} ${chalk.white(formatNumber(s.buyAmount))}`
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

function formatScore(score: number): string {
  if (score >= 80) return chalk.green(score + "/100");
  if (score >= 60) return chalk.yellow(score + "/100");
  return chalk.red(score + "/100");
}

function formatRisk(risk: string): string {
  switch (risk) {
    case "HIGH": return chalk.red("HIGH");
    case "MEDIUM": return chalk.yellow("MEDIUM");
    case "LOW": return chalk.green("LOW");
    default: return chalk.white(risk);
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

function bar(value: number, max = 1, width = 20): string {
  const filled = Math.round((value / max) * width);
  const color = value > 0.5 ? chalk.red : value > 0.2 ? chalk.yellow : chalk.green;
  return color("█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled)));
}
