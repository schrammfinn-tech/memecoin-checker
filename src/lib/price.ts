import axios from "axios";

const DEXSCREENER = "https://api.dexscreener.com";

export interface PriceData {
  pairAddress: string;
  chain: string;
  dex: string;
  tokenName: string;
  tokenSymbol: string;
  priceUsd: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  volume24h: number;
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  txns24hBuys: number;
  txns24hSells: number;
  chartUrl: string;
  url: string;
}

export async function fetchPriceData(tokenAddress: string): Promise<PriceData | null> {
  try {
    const { data } = await axios.get(`${DEXSCREENER}/latest/dex/tokens/${tokenAddress}`, { timeout: 10000 });
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;

    // Pick the pair with highest liquidity
    const best = pairs.reduce((a: any, b: any) =>
      (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b
    );

    return {
      pairAddress: best.pairAddress || "",
      chain: best.chainId || "solana",
      dex: best.dexId || "unknown",
      tokenName: best.baseToken?.name || "",
      tokenSymbol: best.baseToken?.symbol || "",
      priceUsd: parseFloat(best.priceUsd) || 0,
      priceChange1h: best.priceChange?.h1 ?? 0,
      priceChange6h: best.priceChange?.h6 ?? 0,
      priceChange24h: best.priceChange?.h24 ?? 0,
      volume24h: best.volume?.h24 ?? 0,
      liquidityUsd: best.liquidity?.usd ?? 0,
      marketCap: best.marketCap ?? 0,
      fdv: best.fdv ?? 0,
      txns24hBuys: best.txns?.h24?.buys ?? 0,
      txns24hSells: best.txns?.h24?.sells ?? 0,
      chartUrl: `https://dexscreener.com/${best.chainId || "solana"}/${best.pairAddress}?embed=1&theme=dark`,
      url: best.url || `https://dexscreener.com/${best.chainId || "solana"}/${best.pairAddress}`,
    };
  } catch {
    return null;
  }
}
