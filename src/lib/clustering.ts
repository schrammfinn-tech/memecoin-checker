import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";

export interface TransferEdge {
  from: string;
  to: string;
  totalValue: number;
  totalTransfers: number;
  firstDate: number;
  lastDate: number;
}

export interface WalletCluster {
  wallets: Set<string>;
  totalShare: number;
  totalAmount: number;
  edges: TransferEdge[];
  density: number;
}

export async function buildTransferGraph(
  connection: Connection,
  tokenAddress: string,
  maxTx = 100
): Promise<{ edges: TransferEdge[]; nodeShares: Map<string, number> }> {
  const mint = new PublicKey(tokenAddress);
  const edges = new Map<string, TransferEdge>();
  const nodeAmounts = new Map<string, number>();

  const signatures = await connection.getSignaturesForAddress(mint, { limit: maxTx });

  const batchSize = 5;
  for (let i = 0; i < signatures.length; i += batchSize) {
    const batch = signatures.slice(i, i + batchSize);
    await new Promise((r) => setTimeout(r, 250));

    const txs = await connection.getParsedTransactions(
      batch.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    for (const tx of txs) {
      if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) continue;

      const preBalances = tx.meta.preTokenBalances ?? [];
      const postBalances = tx.meta.postTokenBalances ?? [];

      for (let j = 0; j < postBalances.length; j++) {
        const post = postBalances[j];
        if (post.mint !== tokenAddress) continue;

        const pre = preBalances.find(
          (p) => p.accountIndex === post.accountIndex && p.mint === tokenAddress
        );
        const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
        const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
        const diff = postAmount - preAmount;

        if (Math.abs(diff) < 0.000001) continue;

        const owner = post.owner ?? pre?.owner ?? "unknown";
        const currentAmount = nodeAmounts.get(owner) ?? 0;
        nodeAmounts.set(owner, currentAmount + diff);

        if (diff < 0 && pre?.owner) {
          const from = pre.owner;
          const to = owner;
          const edgeKey = `${from}->${to}`;
          const existing = edges.get(edgeKey);
          if (existing) {
            existing.totalValue += Math.abs(diff);
            existing.totalTransfers++;
            existing.lastDate = Math.max(existing.lastDate, tx.blockTime);
            existing.firstDate = Math.min(existing.firstDate, tx.blockTime);
          } else {
            edges.set(edgeKey, {
              from,
              to,
              totalValue: Math.abs(diff),
              totalTransfers: 1,
              firstDate: tx.blockTime,
              lastDate: tx.blockTime,
            });
          }
        }
      }
    }
  }

  return { edges: Array.from(edges.values()), nodeShares: nodeAmounts };
}

export function findClusters(
  edges: TransferEdge[],
  nodeShares: Map<string, number>
): WalletCluster[] {
  const adj = new Map<string, Set<string>>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
    allNodes.add(edge.from);
    allNodes.add(edge.to);
  }

  const visited = new Set<string>();
  const clusters: { wallets: Set<string>; edges: TransferEdge[] }[] = [];

  for (const node of allNodes) {
    if (visited.has(node)) continue;

    const component = new Set<string>();
    const queue = [node];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);

      const neighbors = adj.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
    }

    if (component.size >= 2) {
      const clusterEdges = edges.filter(
        (e) => component.has(e.from) && component.has(e.to)
      );
      clusters.push({ wallets: component, edges: clusterEdges });
    }
  }

  return clusters
    .map((c) => {
      const n = c.wallets.size;
      const maxEdges = (n * (n - 1)) / 2;
      const density = maxEdges > 0 ? c.edges.length / maxEdges : 0;

      return {
        wallets: c.wallets,
        totalAmount: 0,
        totalShare: 0,
        edges: c.edges,
        density,
      };
    })
    .sort((a, b) => b.wallets.size - a.wallets.size);
}

export function computeClusterShare(
  clusters: WalletCluster[],
  holders: { owner: string; share: number; amount: number }[],
  totalSupply: number
): WalletCluster[] {
  const shareMap = new Map<string, { share: number; amount: number }>();
  for (const h of holders) {
    shareMap.set(h.owner, { share: h.share, amount: h.amount });
  }

  for (const c of clusters) {
    let totalAmount = 0;
    let totalShare = 0;
    for (const w of c.wallets) {
      const h = shareMap.get(w);
      if (h) {
        totalAmount += h.amount;
        totalShare += h.share;
      }
    }
    c.totalAmount = totalAmount;
    c.totalShare = totalShare;
  }

  return clusters.sort((a, b) => b.totalShare - a.totalShare);
}
