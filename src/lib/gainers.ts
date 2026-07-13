import axios from "axios";

const DEXSCREENER = "https://api.dexscreener.com";

export interface GainerToken {
  address: string;
  name: string;
  symbol: string;
  priceUsd: number;
  priceChange24h: number;
  liquidityUsd: number;
  marketCap: number;
  url: string;
}

export async function fetchTopGainers(limit = 8): Promise<GainerToken[]> {
  try {
    const { data: boosted } = await axios.get(`${DEXSCREENER}/token-boosts/top/v1`, { timeout: 8000 });
    const profiles = boosted || [];

    const solanaTokens = profiles
      .filter((p: any) => p.chainId === "solana" && p.tokenAddress)
      .map((p: any) => p.tokenAddress)
      .slice(0, 30);

    if (solanaTokens.length === 0) return [];

    const addrList = solanaTokens.join(",");
    const { data: priceData } = await axios.get(
      `${DEXSCREENER}/latest/dex/tokens/${addrList}`,
      { timeout: 10000 }
    );

    const pairs = priceData.pairs || [];

    const gainers: GainerToken[] = [];
    for (const pair of pairs) {
      if (!pair.priceChange?.h24 && !pair.priceChange?.h6) continue;
      const change24h = pair.priceChange?.h24 ?? 0;
      gainers.push({
        address: pair.baseToken?.address || "",
        name: pair.baseToken?.name || "Unknown",
        symbol: pair.baseToken?.symbol || "???",
        priceUsd: parseFloat(pair.priceUsd) || 0,
        priceChange24h: change24h,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        marketCap: pair.marketCap ?? 0,
        url: pair.url || `https://dexscreener.com/solana/${pair.baseToken?.address}`,
      });
    }

    return gainers
      .sort((a, b) => b.priceChange24h - a.priceChange24h)
      .slice(0, limit);
  } catch {
    return [];
  }
}
