# Architecture Overview

## System Diagram

```
                                         cannes-xstocks
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │                                                                                             │
 │   ┌──────────┐    POST /register          ┌─────────────────────────────────────────────┐   │
 │   │          │  ──────────────────────►    │              Express Server                 │   │
 │   │  Mobile  │    { address,              │                 :3000                       │   │
 │   │   App    │      expoPushToken }       │                                             │   │
 │   │          │  ◄──────────────────────    │   ┌─────────┐  ┌──────────┐  ┌──────────┐  │   │
 │   │          │    { token, userId }        │   │  Auth   │  │  SQLite  │  │  Config  │  │   │
 │   └────┬─────┘                             │   │Middleware│  │  data.db │  │datapoints│  │   │
 │        │                                   │   └─────────┘  └──────────┘  └──────────┘  │   │
 │        │  Bearer token for all             │                                             │   │
 │        │  subsequent requests              └──────────────────┬──────────────────────────┘   │
 │        │                                                      │                             │
 │        │   GET /detect                                        │  On register / addAddress    │
 │        │   GET /strategies                                    │                             │
 │        │   POST /strategies/enable                            ▼                             │
 │        │   POST /smart-account/swap              ┌────────────────────────┐                  │
 │        │   ...                                   │   Portfolio Detection  │                  │
 │        │                                         │                        │                  │
 │        │                                         │  1. Fetch from Debank  │                  │
 │        │                                         │  2. Match tokens vs    │                  │
 │        │                                         │     TOKEN_DATAPOINTS   │                  │
 │        │                                         │  3. TSLAx detected?    │                  │
 │        │                                         └───────────┬────────────┘                  │
 │        │                                                     │                              │
 │        │                                    ┌────────────────┼────────────────┐              │
 │        │                                    │                │                │              │
 │        │                                    ▼                ▼                ▼              │
 │        │                          ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
 │        │                          │  Otomato     │ │  Otomato     │ │  Otomato     │        │
 │        │                          │  Workflows   │ │  Workflows   │ │  Workflow    │        │
 │        │                          │  (X Monitor) │ │  (Price)     │ │  (Strategy)  │        │
 │        │                          └──────┬───────┘ └──────┬───────┘ └──────┬───────┘        │
 │        │                                 │                │                │                │
 └────────┼─────────────────────────────────┼────────────────┼────────────────┼────────────────┘
          │                                 │                │                │
          │                                 ▼                ▼                ▼
          │                    ┌──────────────────────────────────────────────────────┐
          │                    │                OTOMATO PLATFORM                      │
          │                    │           (runs workflows in the cloud)              │
          │                    │                                                      │
          │                    │  ┌────────────────────────────────────────────────┐   │
          │                    │  │  X Monitor: @elonmusk (TSLAx)                 │   │
          │                    │  │                                                │   │
          │                    │  │  X Trigger ─► AI Filter ─► Condition ─► AI    │   │
          │                    │  │  @elonmusk    "material     result      Summary│   │
          │                    │  │               to stock?"    == true     ─► Push│   │
          │                    │  └────────────────────────────────────────────────┘   │
          │                    │                                                      │
          │                    │  ┌────────────────────────────────────────────────┐   │
          │                    │  │  X Monitor: @Tesla (TSLAx)                    │   │
          │                    │  │  (same 5-node flow as above)                  │   │
          │                    │  └────────────────────────────────────────────────┘   │
          │                    │                                                      │
          │                    │  ┌────────────────────────┐ ┌─────────────────────┐  │
          │                    │  │ Price >2.5% in 4h      │ │ Price >5% in 24h    │  │
          │                    │  │ Trigger ─► Push        │ │ Trigger ─► Push     │  │
          │                    │  └────────────────────────┘ └─────────────────────┘  │
          │                    │                                                      │
          │                    │  ┌────────────────────────────────────────────────┐   │
          │                    │  │  Strategy: CEO Departure Sell                  │   │
          │                    │  │                                                │   │
          │                    │  │  X Trigger ─► AI Filter ─► Condition           │   │
          │                    │  │  @elonmusk    "stepping     result    ─► POST  │   │
          │                    │  │               down as CEO"  == true      webhook│  │
          │                    │  └──────────────────────────────────┬─────────────┘   │
          │                    │                                     │                 │
          │                    └─────────────────────────────────────┼─────────────────┘
          │                                                         │
          │    Expo Push                      Webhook callback      │
          │  ◄─────────────────────────────   POST /webhook/        │
          │    to user's phone                strategy/:id    ◄─────┘
          │                                         │
          │                                         ▼
          │                    ┌──────────────────────────────────────────┐
          │                    │          STRATEGY EXECUTION              │
          │                    │                                          │
          │                    │  1. Find all users with strategy enabled │
          │                    │  2. For each user:                       │
          │                    │     - Get smart account from DB          │
          │                    │     - Execute CoW Swap (sell TSLAx)      │
          │                    │     - Send push notification             │
          │                    └──────────────────┬───────────────────────┘
          │                                       │
          │                                       ▼
          │                    ┌──────────────────────────────────────────┐
          │                    │      ERC-4337 SMART ACCOUNT (INK)       │
          │                    │                                          │
          │                    │  ZeroDev Kernel v3.1                     │
          │                    │  ┌────────────────────────────────────┐  │
          │                    │  │ Owner EOA (OWNER_PRIVATE_KEY)     │  │
          │                    │  │  └─ Kernel Smart Account          │  │
          │                    │  │       ├─ sudo: owner ECDSA key    │  │
          │                    │  │       └─ session: stored in DB    │  │
          │                    │  └────────────────────────────────────┘  │
          │                    │                                          │
          │                    │  Execution methods:                      │
          │                    │  ├─ CoW Swap (presign flow)              │
          │                    │  │   approve + setPreSignature           │
          │                    │  │   in single batched UserOp            │
          │                    │  └─ Tydro (AAVE fork)                    │
          │                    │      approve + supply in single UserOp   │
          │                    └──────────────────────────────────────────┘
          │
          │
          ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                          IN-HOUSE MONITORING LOOPS                                   │
│                     (run inside the server, no Otomato needed)                        │
│                                                                                      │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────────────────┐   │
│  │  PORTFOLIO SYNC (every 8h)  │  │  EARNINGS (every 6h)                         │   │
│  │                             │  │                                              │   │
│  │  For each user:             │  │  Source: Alpha Vantage                        │   │
│  │  ├─ Fetch portfolio         │  │  Stock: TSLA                                 │   │
│  │  ├─ Compare vs previous     │  │                                              │   │
│  │  ├─ NEW token ─► create WFs │  │  ├─ Detected ─► push "Q1 2026 detected"     │   │
│  │  ├─ GONE token ─► stop WFs  │  │  ├─ 7 days ─► push "earnings in 7 days"     │   │
│  │  └─ BACK token ─► restart   │  │  └─ 24h ─► push "earnings tomorrow"          │   │
│  └─────────────────────────────┘  └──────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────────────────┐   │
│  │  DIVIDENDS (real-time)      │  │  SEC FILINGS (every 24h)                     │   │
│  │                             │  │                                              │   │
│  │  WebSocket subscription     │  │  Source: SEC EDGAR                            │   │
│  │  Ethereum mainnet           │  │  CIK: 0001318605 (Tesla)                     │   │
│  │  Event: MultiplierUpdated   │  │                                              │   │
│  │                             │  │  Tracks: 10-K, 10-Q, 8-K, DEFA14A           │   │
│  │  ├─ Compute dividend/share  │  │  New filing ─► push with link                │   │
│  │  ├─ Push to all users       │  │                                              │   │
│  │  └─ Trigger autosell        │  │  RPC failover:                               │   │
│  │     strategy if enabled     │  │  publicnode → llamarpc → blastapi            │   │
│  │                             │  │                                              │   │
│  │  RPC failover (WebSocket):  │  └──────────────────────────────────────────────┘   │
│  │  publicnode → llamarpc      │                                                     │
│  └─────────────────────────────┘  ┌──────────────────────────────────────────────┐   │
│                                   │  xSTOCKS POINTS (every 24h)                  │   │
│                                   │                                              │   │
│                                   │  Source: backed.fi API                        │   │
│                                   │  Per address, per user                        │   │
│                                   │                                              │   │
│                                   │  Balance increased ─► push with amount+total  │   │
│                                   └──────────────────────────────────────────────┘   │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SERVICES                                       │
│                                                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌─────────────────────┐  │
│  │  Debank    │ │  Alpha     │ │  SEC       │ │ backed.fi│ │  Ethereum           │  │
│  │  Pro API   │ │  Vantage   │ │  EDGAR     │ │  xStocks │ │  WebSocket RPC      │  │
│  │            │ │            │ │            │ │  API     │ │                     │  │
│  │ protocols  │ │ earnings   │ │ filings    │ │ points   │ │ MultiplierUpdated   │  │
│  │ + tokens   │ │ calendar   │ │ 10K/10Q/8K │ │ balance  │ │ events              │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘ └─────────────────────┘  │
│                                                                                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────────────────────────────────────┐  │
│  │  Expo Push │ │  CoW       │ │  Otomato Platform                                │  │
│  │  API       │ │  Protocol  │ │                                                  │  │
│  │            │ │  (INK)     │ │  X trigger, AI blocks, conditions, HTTP actions  │  │
│  │ push notis │ │ swap fills │ │  Runs workflows 24/7 in the cloud                │  │
│  └────────────┘ └────────────┘ └──────────────────────────────────────────────────┘  │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

### Registration Flow
```
User registers with wallet address + Expo push token
  → Debank API fetches all tokens + DeFi positions
    → Match against TOKEN_DATAPOINTS config
      → TSLAx found? Create 4 Otomato workflows:
          1. X Monitor @elonmusk (5 nodes: trigger → AI filter → condition → AI summary → push)
          2. X Monitor @Tesla (same 5-node flow)
          3. Price >2.5% in 4h (2 nodes: trigger → push)
          4. Price >5% in 24h (2 nodes: trigger → push)
      → Store user, addresses, workflows in SQLite
      → All background loops now include this user
```

### Notification Flow
```
Event detected (tweet, price move, earnings date, dividend, SEC filing, points)
  → Determine notification type and payload
    → Resolve push token(s) for target user(s)
      → POST to Expo Push API
        → Push notification on user's phone
```

### Strategy Flow
```
User enables "ceo-departure-sell" strategy
  → Create Otomato workflow: X trigger → AI → condition → webhook
  → Store in user_strategies table
  → Otomato monitors @elonmusk 24/7

Elon tweets "I'm stepping down as CEO"
  → AI filter returns true
  → Condition passes
  → HTTP POST to /webhook/strategy/ceo-departure-sell
    → Server finds all users with strategy enabled
      → For each user with smart account:
          → CoW Swap: sell TSLAx → USDC
          → Push notification: "Strategy executed: Sold TSLAx"
```

### Smart Account Transaction Flow
```
Trade needed (strategy execution or user-initiated swap)
  → Load session key from SQLite
  → Build UserOperation:
      For CoW Swap: approve vault relayer + setPreSignature (batched)
      For Tydro: approve + supply (batched)
  → Send via ZeroDev bundler on INK (chain 57073)
  → Bundler submits to chain
  → CoW solvers fill the order off-chain
```

### Portfolio Sync Loop
```
Every 8 hours:
  For each registered user:
    → Fetch current portfolio from Debank
    → Extract monitored tokens
    → Compare with previous state (from workflows in DB):
        NEW positions → create Otomato workflows
        REMOVED positions → stop Otomato workflows
        RE-DETECTED positions → restart stopped workflows
```

## File Map

```
cannes-xstocks/
├── index.js              # Express server, all routes, startup
├── db.js                 # SQLite schema + queries
├── config/
│   └── datapoints.js     # TOKEN_DATAPOINTS config (tokens, addresses, monitoring rules)
├── workflows.js          # Otomato SDK workflow creation (X monitor, price, strategies)
├── strategies.js         # Strategy templates, execution logic, webhook handler
├── sync.js               # 8h portfolio sync loop
├── earnings.js           # 6h earnings check (Alpha Vantage)
├── dividends.js          # Real-time dividend events (Ethereum WebSocket)
├── disclosures.js        # 24h SEC EDGAR filing check
├── xstocks-points.js     # 24h xStocks points check (backed.fi)
├── smart-account.mjs     # ZeroDev smart account + CoW Swap + Tydro
├── data.db               # SQLite database (users, addresses, workflows, strategies, smart accounts)
├── architecture.excalidraw
└── docs/
    ├── architecture.md   # This file
    ├── api.md            # API reference
    ├── push-notifications.md
    ├── testing.md
    ├── add-more-stocks-support.md
    └── status.md
```
