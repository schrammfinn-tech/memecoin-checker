import { Router, Request, Response } from "express";
import { HeliusClient } from "../lib/helius";
import { createConnection } from "../lib/solana";
import { detectSnipers } from "../lib/wallet";
import { comprehensiveAnalyze } from "../lib/risk-engine";
import { scanSocials } from "../lib/social-scanner";
import { fetchPriceData } from "../lib/price";

export const apiRouter = Router();

function getHelius(): HeliusClient {
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("RPC not configured");
  return new HeliusClient(rpcUrl);
}
function getRpc(): string {
  return process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "";
}

apiRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

apiRouter.get("/check/:tokenAddress", async (req: Request, res: Response) => {
  try {
    const { tokenAddress } = req.params;
    const helius = getHelius();
    const rpcUrl = getRpc();
    const result = await comprehensiveAnalyze(tokenAddress, helius, rpcUrl);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/sniper/:tokenAddress", async (req: Request, res: Response) => {
  try {
    const { tokenAddress } = req.params;
    const rpcUrl = getRpc();
    if (!rpcUrl) throw new Error("RPC not configured");
    const connection = createConnection(rpcUrl);
    const threshold = parseInt(req.query.threshold as string) || 30000;

    const helius = getHelius();
    const holders = await helius.getTopHolders(tokenAddress, 80, false);
    const wallets = holders.filter((h) => !h.isContract && !h.isDex).slice(0, 5);
    const results = await detectSnipers(connection, tokenAddress, wallets, threshold);
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/social/:tokenAddress", async (req: Request, res: Response) => {
  try {
    const { tokenAddress } = req.params;
    const result = await scanSocials(tokenAddress);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/price/:tokenAddress", async (req: Request, res: Response) => {
  try {
    const { tokenAddress } = req.params;
    const result = await fetchPriceData(tokenAddress);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
