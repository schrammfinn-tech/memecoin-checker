import axios from "axios";
import { callWithRetry, isRateLimit, RateLimitError } from "./rate-limiter";

export interface LargestAccount {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number;
  uiAmountString: string;
}

export interface HolderInfo {
  address: string;
  owner: string;
  share: number;
  amount: number;
  isContract: boolean;
  isDex: boolean;
  knownLabel: string | null;
}

const DEX_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
  "LBUZKhRxPF3X4jYFbMGqCcEYLcQft2Mn4vEq7zwqR4R",
  "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ",
  "Eo7WjkSi7LqHeNCPK7HNqy3qGPi3QL8SHrbfGpjmQRUP",
]);

const KNOWN_PROGRAMS: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  "TSLvdd1pWpHVjahSpsvCXUbgwsY3VUydYnR1DQK7H9F": "Pump.fun Auth",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter",
  "LBUZKhRxPF3X4jYFbMGqCcEYLcQft2Mn4vEq7zwqR4R": "Meteora",
};

export class HeliusClient {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  // All calls go through the shared global limiter (see ./rate-limiter), which
  // enforces the app-wide rate/concurrency budget and retries 429s with backoff.
  private async rpcCall(method: string, params: any, retries?: number): Promise<any> {
    return callWithRetry(async () => {
      const resp = await axios.post(
        this.rpcUrl,
        { jsonrpc: "2.0", id: 1, method, params },
        { timeout: 12000, validateStatus: () => true }
      );

      if (resp.status === 429) {
        throw new RateLimitError(`HTTP 429 on ${method}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        const e: any = new Error(`RPC HTTP ${resp.status} on ${method}`);
        e.status = resp.status;
        throw e;
      }

      const data = resp.data;
      if (data && data.error) {
        const msg = data.error.message || "";
        if (isRateLimit(data.error.code, msg)) {
          throw new RateLimitError(`RPC ${method}: ${msg}`);
        }
        throw new Error(`RPC error (${method}): ${msg}`);
      }
      return data ? data.result : undefined;
    }, retries);
  }

  async getTokenLargestAccounts(mint: string): Promise<LargestAccount[]> {
    return this.rpcCall("getTokenLargestAccounts", [mint])
      .then((r: any) => (r?.value || []).slice(0, 80), () => []);
  }

  // DAS API — returns token accounts with owner + amount resolved. Reliable on Helius.
  private async getTokenAccountsDAS(mint: string, decimals: number, maxPages = 5): Promise<{ address: string; owner: string; uiAmount: number; rawAmount: number }[]> {
    const all: { address: string; owner: string; uiAmount: number; rawAmount: number }[] = [];
    const divisor = Math.pow(10, decimals);
    for (let page = 1; page <= maxPages; page++) {
      let result: any;
      try {
        result = await this.rpcCall("getTokenAccounts", { mint, limit: 1000, page });
      } catch {
        break;
      }
      const accts = result?.token_accounts || [];
      if (accts.length === 0) break;
      for (const a of accts) {
        const raw = Number(a.amount) || 0;
        if (raw <= 0) continue;
        all.push({
          address: a.address,
          owner: a.owner || "unknown",
          uiAmount: raw / divisor,
          rawAmount: raw,
        });
      }
      if (accts.length < 1000) break;
    }
    all.sort((a, b) => b.uiAmount - a.uiAmount);
    return all;
  }

  private async getHoldersFromProgramAccounts(mint: string): Promise<LargestAccount[]> {
    const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const filters = [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
    const result = await this.rpcCall("getProgramAccounts", [TOKEN_PROGRAM, { filters, encoding: "jsonParsed" }]);

    const accounts: LargestAccount[] = [];
    for (const acc of result) {
      const info = acc.account.data.parsed.info;
      const uiAmount = info.tokenAmount.uiAmount;
      if (uiAmount > 0) {
        accounts.push({
          address: acc.pubkey,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          uiAmount: uiAmount,
          uiAmountString: info.tokenAmount.uiAmountString,
        });
      }
    }
    accounts.sort((a, b) => b.uiAmount - a.uiAmount);
    return accounts;
  }

  async getTokenSupply(mint: string): Promise<{ amount: string; decimals: number; uiAmount: number }> {
    const result = await this.rpcCall("getTokenSupply", [mint]);
    return result.value;
  }

  private async getAccountOwnerBatched(addresses: string[]): Promise<Map<string, string>> {
    const owners = new Map<string, string>();
    if (addresses.length === 0) return owners;

    const batchSize = 50;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      try {
        const resp = await this.rpcCall("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]);
        for (let j = 0; j < resp.value.length; j++) {
          const entry = resp.value[j];
          if (entry) {
            owners.set(batch[j], entry.data?.parsed?.info?.owner || entry.owner || "unknown");
          }
        }
      } catch {
        // skip failed batch
      }
    }
    return owners;
  }

  async getTopHolders(mint: string, limit = 80, resolveOwners = true): Promise<HolderInfo[]> {
    // Fast path: get supply first (critical)
    let supply: { amount: string; decimals: number; uiAmount: number };
    try {
      supply = await this.getTokenSupply(mint);
    } catch {
      supply = { amount: "0", decimals: 0, uiAmount: 1 };
    }
    const totalSupply = supply.uiAmount || 1;

    // Primary: DAS API getTokenAccounts (owner + amount resolved, reliable on Helius)
    try {
      const das = await this.getTokenAccountsDAS(mint, supply.decimals);
      if (das.length > 0) {
        return das.slice(0, limit).map((a) => ({
          address: a.address,
          owner: a.owner,
          share: a.uiAmount / totalSupply,
          amount: a.uiAmount,
          isContract: a.owner !== "unknown" ? a.owner.length > 44 : false,
          isDex: DEX_PROGRAMS.has(a.owner),
          knownLabel: KNOWN_PROGRAMS[a.owner] || null,
        }));
      }
    } catch {}

    // Fallback: getTokenLargestAccounts + owner resolution
    let topAccounts: LargestAccount[] = [];
    try {
      const largest = await this.getTokenLargestAccounts(mint);
      topAccounts = largest.slice(0, limit);
    } catch {}

    let ownerMap = new Map<string, string>();
    if (resolveOwners && topAccounts.length > 0) {
      const lookupCount = Math.min(topAccounts.length, 20);
      ownerMap = await this.getAccountOwnerBatched(
        topAccounts.slice(0, lookupCount).map((a) => a.address)
      );
    }

    return topAccounts.map((acc) => {
      const owner = ownerMap.get(acc.address) || "unknown";
      return {
        address: acc.address,
        owner,
        share: acc.uiAmount / totalSupply,
        amount: acc.uiAmount,
        isContract: owner !== "unknown" ? owner.length > 44 : false,
        isDex: DEX_PROGRAMS.has(owner),
        knownLabel: KNOWN_PROGRAMS[owner] || null,
      };
    });
  }

  async analyzeToken(mint: string): Promise<TokenOnChainAnalysis> {
    const holders = await this.getTopHolders(mint, 80, true);
    const totalSupply = holders[0] && holders[0].share > 0
      ? holders[0].amount / holders[0].share
      : holders.reduce((s, h) => s + h.amount, 0);

    let dexShare = 0;
    let contractShare = 0;
    let top10Share = 0;
    let top20Share = 0;

    for (let i = 0; i < holders.length; i++) {
      const h = holders[i];
      if (h.isDex) dexShare += h.share;
      if (h.isContract && !h.isDex) contractShare += h.share;
      if (i < 10) top10Share += h.share;
      if (i < 20) top20Share += h.share;
    }

    const walletHolders = holders.filter((h) => !h.isContract && !h.isDex);
    const walletTop10Share = walletHolders.slice(0, 10).reduce((s, h) => s + h.share, 0);

    const sortedShares = [...holders].sort((a, b) => a.share - b.share).map((h) => h.share);
    const gini = computeGini(sortedShares);

    let cumulative = 0;
    let nakamoto = 0;
    const sorted = [...holders].sort((a, b) => b.share - a.share);
    for (const h of sorted) {
      cumulative += h.share;
      nakamoto++;
      if (cumulative >= 0.5) break;
    }

    const bundleRisk = walletTop10Share > 0.5 ? "HIGH" : walletTop10Share > 0.3 ? "MEDIUM" : "LOW";
    const score = Math.max(0, Math.min(100,
      100 - (walletTop10Share * 100) - (gini * 50) - Math.max(0, (nakamoto - 3) * 5)
    ));

    return {
      mint,
      totalSupply,
      holders,
      supplyStats: { dexShare, contractShare, top10Share, top20Share, walletTop10Share },
      scores: { decentralizationScore: Math.round(score), giniIndex: gini, nakamotoCoefficient: nakamoto },
      bundleRisk,
    };
  }
}

function computeGini(shares: number[]): number {
  if (shares.length === 0) return 0;
  const n = shares.length;
  let sumOfDifferences = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumOfDifferences += Math.abs(shares[i] - shares[j]);
    }
  }
  const mean = shares.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 1;
  return sumOfDifferences / (2 * n * n * mean);
}

export interface TokenOnChainAnalysis {
  mint: string;
  totalSupply: number;
  holders: HolderInfo[];
  supplyStats: {
    dexShare: number;
    contractShare: number;
    top10Share: number;
    top20Share: number;
    walletTop10Share: number;
  };
  scores: {
    decentralizationScore: number;
    giniIndex: number;
    nakamotoCoefficient: number;
  };
  bundleRisk: "LOW" | "MEDIUM" | "HIGH";
}
