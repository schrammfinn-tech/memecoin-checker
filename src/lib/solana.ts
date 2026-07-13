import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";

export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
}

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FUN_MINT_AUTH = "TSLvdd1pWpHVjahSpsvCXUbgwsY3VUydYnR1DQK7H9F";

export async function getTokenSupply(
  connection: Connection,
  mintAddress: string
): Promise<{ decimals: number; uiAmount: number | null }> {
  const mint = new PublicKey(mintAddress);
  const info = await connection.getTokenSupply(mint);
  return {
    decimals: info.value.decimals,
    uiAmount: info.value.uiAmount,
  };
}

export async function getTokenMetadata(
  connection: Connection,
  mintAddress: string
): Promise<{ name?: string; symbol?: string; uri?: string } | null> {
  try {
    const mint = new PublicKey(mintAddress);
    const accountInfo = await connection.getParsedAccountInfo(mint);
    return null; // Most metadata is in Metaplex, use Helius for this
  } catch {
    return null;
  }
}

export async function getSignaturesForAddress(
  connection: Connection,
  address: string,
  limit = 100,
  before?: string
): Promise<string[]> {
  const pubkey = new PublicKey(address);
  const sigs = await connection.getSignaturesForAddress(pubkey, {
    limit,
    before,
  });
  return sigs.map((s) => s.signature);
}

export async function getParsedTransactions(
  connection: Connection,
  signatures: string[]
): Promise<(ParsedTransactionWithMeta | null)[]> {
  if (signatures.length === 0) return [];

  // Batch by 25 (RPC limit)
  const batchSize = 25;
  const results: (ParsedTransactionWithMeta | null)[] = [];

  for (let i = 0; i < signatures.length; i += batchSize) {
    const batch = signatures.slice(i, i + batchSize);
    const txs = await connection.getParsedTransactions(batch, {
      maxSupportedTransactionVersion: 0,
    });
    results.push(...txs);
  }

  return results;
}

export interface TokenTransfer {
  from: string;
  to: string;
  amount: number;
  mint: string;
  timestamp: number;
  signature: string;
}

export function extractTokenTransfers(
  tx: ParsedTransactionWithMeta | null,
  targetMint: string
): TokenTransfer[] {
  const transfers: TokenTransfer[] = [];
  if (!tx || !tx.meta || tx.meta.err) return transfers;

  const timestamp = (tx.blockTime ?? 0) * 1000;
  const preBalances = tx.meta.preTokenBalances ?? [];
  const postBalances = tx.meta.postTokenBalances ?? [];

  for (let i = 0; i < postBalances.length; i++) {
    const post = postBalances[i];
    if (post.mint !== targetMint) continue;

    const pre = preBalances.find(
      (p) => p.accountIndex === post.accountIndex && p.mint === targetMint
    );

    const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
    const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
    const diff = postAmount - preAmount;

    if (diff === 0) continue;

    const owner = post.owner ?? pre?.owner;
    if (!owner) continue;

    transfers.push({
      from: diff < 0 ? owner : "unknown",
      to: diff > 0 ? owner : "unknown",
      amount: Math.abs(diff),
      mint: targetMint,
      timestamp,
      signature: tx.transaction.signatures[0],
    });
  }

  return transfers;
}

export function isPumpFunToken(owner: string): boolean {
  return owner === PUMP_FUN || owner === PUMP_FUN_MINT_AUTH;
}
