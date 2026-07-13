#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import chalk from "chalk";
import { HeliusClient } from "./lib/helius";
import { createConnection } from "./lib/solana";
import { fullAnalyze, detectSnipers } from "./lib/wallet";
import { formatAnalysis, formatHolders, formatSniperResults } from "./lib/formatter";
import { HolderInfo } from "./lib/helius";

dotenv.config();

const program = new Command();

program
  .name("memecheck")
  .description("Solana memecoin wallet analysis")
  .version("1.0.0");

function getClients() {
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;

  if (!rpcUrl) {
    console.error(chalk.red("Error: HELIUS_RPC_URL or SOLANA_RPC_URL not set in .env file"));
    process.exit(1);
  }

  return {
    helius: new HeliusClient(rpcUrl),
    rpcUrl,
  };
}

program
  .command("check <tokenAddress>")
  .description("Full analysis: holders, distribution, snipers, risk score")
  .action(async (tokenAddress: string) => {
    const { helius, rpcUrl } = getClients();

    console.log(chalk.gray(`Analyzing ${tokenAddress}...`));

    try {
      const result = await fullAnalyze(tokenAddress, helius, rpcUrl);
      console.log(formatAnalysis(result));
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command("holders <tokenAddress>")
  .description("Show top token holders")
  .option("-l, --limit <limit>", "Number of holders", "30")
  .action(async (tokenAddress: string, options: { limit: string }) => {
    const { helius } = getClients();

    try {
      const holders = await helius.getTopHolders(tokenAddress, parseInt(options.limit));
      console.log(formatHolders(holders, parseInt(options.limit)));
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command("sniper <tokenAddress>")
  .description("Detect snipers who bought immediately after launch")
  .option("-t, --threshold <ms>", "Sniping threshold in ms", "30000")
  .action(async (tokenAddress: string, options: { threshold: string }) => {
    const { rpcUrl } = getClients();
    const connection = createConnection(rpcUrl);
    const threshold = parseInt(options.threshold);

    console.log(chalk.gray(`Scanning for snipers (threshold: ${threshold}ms)...`));

    try {
      const holders = await new HeliusClient(rpcUrl).getTopHolders(tokenAddress, 80);
      const wallets = holders.filter((h) => !h.isContract && !h.isDex);
      const results = await detectSnipers(connection, tokenAddress, wallets, threshold);
      console.log(formatSniperResults(results));
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command("web")
  .description("Start the web dashboard")
  .option("-p, --port <port>", "Port number", process.env.PORT || "3000")
  .option("--no-open", "Don't open browser")
  .action(async (options: { port: string; open: boolean }) => {
    const { startServer } = await import("./server");
    startServer(parseInt(options.port), options.open);
  });

program.parse();
