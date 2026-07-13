# Memecoin Checker

On-chain analysis tool for Solana memecoins. Detect bundles, cluster wallets, check liquidity locks, scan developer history, and spot red flags before you trade.

## Features

| Module | Description |
|--------|-------------|
| **Holder Analysis** | Top holder concentration, wallet/DEX/contract classification, Gini index, Nakamoto coefficient |
| **Wallet Clustering** | Transfer-graph based cluster detection with interactive canvas visualization |
| **Bundle Detection** | Coordinated launch detection — same-block buys, common funder analysis |
| **Liquidity Lock** | LP burn verification, lock status, deployer-held LP detection |
| **Developer History** | Rug rate tracking, token lifespan analysis, "known rugger" labeling |
| **Social Scanner** | Twitter engagement fraud detection, Telegram bot-padding checks, rug keyword scanning |
| **Sniper Detection** | Early buyer identification with timing analysis |
| **Risk Scoring** | 7-factor weighted score: holder concentration, clustering, bundles, liquidity, dev rep, social, snipers |
| **Price Chart** | Embedded DexScreener chart with live price, volume, liquidity, and market cap |

## Quick Start

```bash
git clone https://github.com/schrammfinn-tech/memecoin-checker.git
cd memecoin-checker
npm install
cp .env.example .env
```

Edit `.env` with your [Helius RPC URL](https://helius.dev) (free tier works):

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

Then:

```bash
# Desktop app
npm start

# Or CLI mode
npm run cli -- check <token-address>
npm run cli -- holders <token-address>
npm run cli -- sniper <token-address>
```

## Build Standalone .exe

```bash
npm run dist:win
```

Output in `release/`. Requires no installation — just place a `.env` next to the `.exe`.

## Architecture

```
src/
├── electron/main.ts     # Electron main process
├── app.ts               # Express app factory
├── server.ts            # Standalone server entry
├── cli.ts               # CLI entry (Commander.js)
├── lib/
│   ├── helius.ts        # Solana RPC client
│   ├── wallet.ts        # Sniper detection
│   ├── clustering.ts    # Transfer graph cluster analysis
│   ├── bundle-detector.ts  # Coordinated buy detection
│   ├── liquidity.ts     # LP lock/burn verification
│   ├── dev-history.ts   # Developer rug tracking
│   ├── social-scanner.ts   # Twitter/Telegram analysis
│   ├── price.ts         # DexScreener price data
│   ├── risk-engine.ts   # Multi-factor risk scoring
│   ├── solana.ts        # Solana RPC helpers
│   └── formatter.ts     # CLI output formatting
├── routes/api.ts        # REST API endpoints
└── public/index.html    # Web UI
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/check/:token` | Full analysis (holders, clusters, bundles, LP, dev, social, risk) |
| `GET /api/price/:token` | Price data from DexScreener |
| `GET /api/social/:token` | Social media scan |
| `GET /api/sniper/:token` | Sniper detection |

## License

MIT
