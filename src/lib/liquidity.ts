import { Connection, PublicKey } from "@solana/web3.js";

export interface LiquidityLockResult {
  hasLP: boolean;
  lpMint: string | null;
  totalLP: number;
  burnedLP: number;
  burnedPercent: number;
  lockedLP: number;
  lockedPercent: number;
  topLPHolderShare: number;
  deployerHoldsLP: boolean;
  status: "BURNED" | "LOCKED" | "UNLOCKED" | "NO_LP" | "ERROR";
  risk: "SAFE" | "MODERATE" | "HIGH" | "VERY_HIGH";
}

const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const ORCA_WHIRLPOOLS = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const NULL_ADDRESS = "11111111111111111111111111111111";
const BURN_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "DeadDeadDeadDeadDeadDeadDeadDeadDeadDead",
  "1nc1nerator11111111111111111111111111111111",
]);

export async function analyzeLiquidityLock(
  connection: Connection,
  tokenAddress: string,
  deployer: string
): Promise<LiquidityLockResult> {
  try {
    const lpMint = await findLPMint(connection, tokenAddress);
    if (!lpMint) {
      return {
        hasLP: false, lpMint: null, totalLP: 0, burnedLP: 0,
        burnedPercent: 0, lockedLP: 0, lockedPercent: 0,
        topLPHolderShare: 0, deployerHoldsLP: false,
        status: "NO_LP", risk: "VERY_HIGH",
      };
    }

    const lpSupply = await connection.getTokenSupply(new PublicKey(lpMint));
    const totalLP = lpSupply.value.uiAmount ?? 0;

    const largestLP = await connection.getTokenLargestAccounts(new PublicKey(lpMint));

    let burnedLP = 0;
    let lockedLP = 0;
    let deployerLP = 0;
    let topHolderLP = 0;

    for (const acc of largestLP.value) {
      const info = await connection.getParsedAccountInfo(new PublicKey(acc.address));
      const owner = (info.value?.data as any)?.parsed?.info?.owner ?? "";

      if (BURN_ADDRESSES.has(owner)) {
        burnedLP += acc.uiAmount ?? 0;
      }

      if (owner === deployer) {
        deployerLP += acc.uiAmount ?? 0;
      }

      if (topHolderLP === 0) {
        topHolderLP = acc.uiAmount ?? 0;
      }
    }

    const burnedPercent = totalLP > 0 ? burnedLP / totalLP : 0;
    const topLPHolderShare = totalLP > 0 ? topHolderLP / totalLP : 0;

    let status: LiquidityLockResult["status"] = "UNLOCKED";
    let risk: LiquidityLockResult["risk"] = "VERY_HIGH";

    if (burnedPercent > 0.9) {
      status = "BURNED";
      risk = "SAFE";
    } else if (burnedPercent > 0.5) {
      status = "BURNED";
      risk = "MODERATE";
    } else if (lockedLP > 0 && lockedLP / totalLP > 0.5) {
      status = "LOCKED";
      risk = "MODERATE";
    } else if (deployerLP > 0 && deployerLP / totalLP > 0.3) {
      status = "UNLOCKED";
      risk = "HIGH";
    } else {
      status = "UNLOCKED";
      risk = topLPHolderShare > 0.8 ? "HIGH" : "VERY_HIGH";
    }

    return {
      hasLP: true,
      lpMint,
      totalLP,
      burnedLP,
      burnedPercent,
      lockedLP,
      lockedPercent: totalLP > 0 ? lockedLP / totalLP : 0,
      topLPHolderShare,
      deployerHoldsLP: deployerLP > 0,
      status,
      risk,
    };
  } catch {
    return {
      hasLP: false, lpMint: null, totalLP: 0, burnedLP: 0,
      burnedPercent: 0, lockedLP: 0, lockedPercent: 0,
      topLPHolderShare: 0, deployerHoldsLP: false,
      status: "ERROR", risk: "VERY_HIGH",
    };
  }
}

async function findLPMint(
  connection: Connection,
  tokenAddress: string
): Promise<string | null> {
  try {
    const mintPubkey = new PublicKey(tokenAddress);

    const raydiumV4Pool = findPDA(
      RAYDIUM_AMM_V4,
      "amm",
      mintPubkey
    );

    if (raydiumV4Pool) {
      const poolInfo = await connection.getParsedAccountInfo(raydiumV4Pool);
      if (poolInfo.value) {
        const data = (poolInfo.value.data as any)?.parsed?.info;
        if (data?.lpMint) return data.lpMint;
      }
    }

    const sigs = await connection.getSignaturesForAddress(mintPubkey, { limit: 50 });
    const txs = await connection.getParsedTransactions(
      sigs.slice(0, 10).map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    const lpMints = new Set<string>();
    for (const tx of txs) {
      if (!tx?.meta) continue;
      const postBalances = tx.meta.postTokenBalances ?? [];
      for (const b of postBalances) {
        if (
          b.mint !== tokenAddress &&
          b.mint !== "So11111111111111111111111111111111111111112" &&
          (b.uiTokenAmount?.uiAmount ?? 0) > 0 &&
          b.owner !== tokenAddress
        ) {
          lpMints.add(b.mint);
        }
      }
    }

    if (lpMints.size > 0) {
      for (const m of lpMints) {
        const info = await connection.getTokenSupply(new PublicKey(m));
        if (info.value.uiAmount && info.value.uiAmount < 1_000_000_000) {
          return m;
        }
      }
      return [...lpMints][0];
    }

    return null;
  } catch {
    return null;
  }
}

function findPDA(programId: string, seed: string, mint: PublicKey): PublicKey | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(seed), mint.toBuffer()],
      new PublicKey(programId)
    );
    return pda;
  } catch {
    return null;
  }
}
