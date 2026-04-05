# cannes-xstocks

Portfolio-aware notification backend for xStocks tokenized equities. Detects which tokens you hold, then automatically monitors everything that matters and sends push notifications to your phone.

## Prerequisites

- Node.js 18+
- npm

## Setup

```bash
git clone https://github.com/Otomatorg/xstocks-hackathon-backend.git
cd xstocks-hackathon-backend
npm install
cp .env.example .env
```

Edit `.env` with your keys (see below), then:

```bash
node index.js
```

The server starts on port 3000 with all background loops (earnings, points, dividends, SEC filings, portfolio sync).

To expose it publicly (for Expo push webhooks and Otomato callbacks):

```bash
ngrok http 3000
```

## Environment Variables

| Variable | Required | How to get it |
|----------|----------|---------------|
| `DEBANK_API_KEY` | Yes | [Debank Open API](https://open.debank.com/) -- paid plan required for `all_complex_protocol_list` and `all_token_list` |
| `OTOMATO_AUTH` | Yes | Otomato auth token (JWT or xtoken). See below for a sample value |
| `ALPHA_VANTAGE_KEY` | Yes | [alphavantage.co/support](https://www.alphavantage.co/support/#api-key) -- free, instant, 25 requests/day |
| `PORT` | No | Defaults to `3000` |
| `ZERODEV_RPC` | No | Only for smart account / auto-trading. Create a project at [dashboard.zerodev.app](https://dashboard.zerodev.app) for INK (chain 57073) |
| `OWNER_PRIVATE_KEY` | No | Only for smart account. Any fresh EOA private key (this wallet becomes the smart account owner) |

### Quick start with just notifications (no smart accounts)

Only `DEBANK_API_KEY`, `OTOMATO_AUTH`, and `ALPHA_VANTAGE_KEY` are needed. Smart account variables are optional -- the server runs fine without them, you just won't have auto-trading strategies or swap execution.

### Getting the keys

**Debank API Key:** Sign up at [open.debank.com](https://open.debank.com/). The Pro API plan is needed. The key looks like `ec436bc3b769cb5aa831d0fa69edfa3f92e71793`.

**Otomato Auth Token:** Used to create Otomato workflows. Accepts either an xtoken (`xtoken:XXXX`) or a JWT. You can use this sample JWT for testing:

```
OTOMATO_AUTH=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhcHAub3RvbWF0by54eXoiLCJjdHgiOnsiaWQiOiJjOTc0ODVhZi1kMGQ5LTQxOWQtOWE4Mi00MjRjMGUzNTM3MzgiLCJuYW1lIjpudWxsLCJlbWFpbCI6bnVsbCwid2FsbGV0UHJvdmlkZXIiOiJ0aGlyZHdlYiIsImF1dGhQcm92aWRlciI6InRoaXJkd2ViIiwid2FsbGV0QWRkcmVzcyI6IjB4NjUyMzlkNkUzQzcyNWYzNjdmNEQxQzM1NjYwNTdhMGIzNWZEOTJkNyIsIm93bmVyV2FsbGV0QWRkcmVzcyI6IjB4YzBlN2RCYzIzMUU2MzEzNTFEZUFhNTI2YjI3NThkNDQ4Njg2MWJDNSJ9LCJleHAiOjE3Nzc2NjA2NTcsImlhdCI6MTc3NTA2ODY1NywiaXNzIjoiMHg3Y0VCOGQ4MTQ3QWFhOWRCODFBY0JERkU1YzMwNTBERkNmRjE4NTM3IiwianRpIjoiMHhkZGRmYTY2Y2E0ZWIyZDFhNGYzMmU2NjJlNDk5MDdjOTM2ZDNjYjNhM2E3MDNmZjdiNjY5NGQ4Yzc5OWI1NTRmIiwibmJmIjoxNzc1MDY2ODU0LCJzdWIiOiIweDY1MjM5ZDZFM0M3MjVmMzY3ZjREMUMzNTY2MDU3YTBiMzVmRDkyZDcifQ.MHg1MjlhMjZhNGIyMTI3ODM4YTY3MmIzOTJkZGYwMWRkYzRmYmVhZWU2YWQ2ODNjOGY1N2Y3NzdjZDllM2ZmZTVjMDM5MzBjMjJhOTY3MGU3M2ZmNGI4NDZiZDk1OGVjMjU0YmUzMDUyMmQ5OTJhNGY5YWUzNGEwNzkzMzNlODY1ZjFj
```

This token expires on 2026-06-01. For production, generate one from the Otomato app or use `xtoken:XXXX` from the webserver.

**Alpha Vantage Key:** Go to [alphavantage.co/support/#api-key](https://www.alphavantage.co/support/#api-key), enter any email, get the key instantly. Free tier is sufficient (we poll every 6 hours, well within the 25/day limit).

**ZeroDev RPC (optional):** Create an account at [dashboard.zerodev.app](https://dashboard.zerodev.app), create a new project, select INK (chain 57073), copy the bundler RPC URL.

**Owner Private Key (optional):** Generate any new wallet (e.g. `node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"`). This wallet doesn't need funds -- it's only used to derive the smart account address.

## Verify it's working

After starting the server, you should see:

```
Listening on :3000
[sync] Portfolio sync loop started (every 8h)
[earnings] Monitoring loop started (every 6h)
[xstocks-points] Monitoring loop started (every 24h)
[disclosures] Monitoring loop started (every 24h)
[dividends] Baseline multiplier for TSLAx: 1.0
[dividends] Subscribed to MultiplierUpdated on TSLAx (0x8ad3...)
[dividends] Monitoring 1 contract(s) for MultiplierUpdated events
```

Then register a user:

```bash
curl -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"address":"0x1C6892bf59Cec8241b215bb9bEA561b7294b052D","expoPushToken":"ExponentPushToken[your_token]"}'
```

If the address holds TSLAx, you'll see `Created 3 workflows for user ...` in the logs.

## How it works

1. You register with your wallet address
2. We scan your portfolio and detect xStocks tokens (e.g. TSLAx)
3. For each detected token, we automatically set up all relevant monitoring
4. You receive push notifications when something happens

### Portfolio Sync Loop

Every 8 hours, the server re-scans the portfolio of every registered user. It compares the current state against the previous one:

- **New position detected** (user bought TSLAx): Creates all monitoring workflows for that token (X monitor, price alerts)
- **Position removed** (user sold TSLAx): Stops all associated Otomato workflows
- **Position re-detected** (user bought back): Restarts the previously stopped workflows instead of creating duplicates

This means monitoring is always in sync with what the user actually holds, without any manual action.

### Documentation

- [API Reference](docs/api.md) -- Full endpoint documentation
- [Push Notification Payloads](docs/push-notifications.md) -- Payload format for each notification type
- [Testing Endpoints](docs/testing.md) -- Admin endpoints for demo and testing
- [Adding More Stocks](docs/add-more-stocks-support.md) -- How to add support for new xStocks tokens
- [Project Status](docs/status.md) -- What's built and what remains for production

---

## Notifications for Tesla (TSLAx)

When TSLAx is detected in your wallet, the following notifications are activated automatically.

### Elon Musk tweets (AI-filtered)

**What:** When Elon Musk posts on X (Twitter), an AI evaluates whether the tweet could impact Tesla's stock price. Only relevant tweets are forwarded to you with a one-sentence summary.

**Data source:** X (Twitter) via Otomato's real-time tweet monitoring

**Logic:** The workflow has 5 steps:
1. New tweet detected from @elonmusk
2. An AI filter decides if the tweet is material to Tesla's stock price (earnings, production, regulatory, product launches, M&A, etc.)
3. If not material (memes, personal opinions, crypto/DOGE, political commentary), the tweet is silently dropped
4. If material, a second AI generates a concise summary for TSLAx holders
5. Push notification sent with the summary and a link to the original tweet

**Example:** "Tesla announces record Q1 deliveries, beating analyst estimates by 12%"

**Not forwarded:** "Just landed in Austin, great weather today" / DOGE memes / SpaceX updates

---

### Price movement

**What:** Get notified when the TSLAx token price moves significantly.

**Data source:** On-chain price feeds via Otomato

**Logic:** Two thresholds are monitored continuously:
- Price moves more than **2.5% in 4 hours**
- Price moves more than **5% in 24 hours**

**Example:** "TSLAx moved 3.2% in 4 hours"

---

### Earnings calls

**What:** Stay informed about upcoming Tesla quarterly earnings. You receive three notifications per earnings call:
1. **When detected** -- As soon as a new earnings date appears in the calendar
2. **7 days before** -- One week reminder
3. **24 hours before** -- Final reminder the day before

**Data source:** Alpha Vantage Earnings Calendar API (checked every 6 hours)

**Logic:** We poll the earnings calendar for Tesla (TSLA). When a new earnings date appears, we notify you immediately. As the date approaches, we send reminders at 7 days and 24 hours. Each notification includes the quarter (e.g. Q1 2026) and the consensus EPS estimate when available.

**Example:** "TSLAx Q1 2026 earnings call in 2 days"

---

### Dividends

**What:** Get notified instantly when a dividend is distributed on the TSLAx token.

**Data source:** Ethereum blockchain (real-time event subscription)

**Logic:** We listen for `MultiplierUpdated` events on the TSLAx smart contract. When the multiplier increases, it means a dividend was distributed. We calculate the dividend amount per share and the percentage yield.

**Example:** "TSLAx dividend: 0.0050 per share (0.5%)"

---

### SEC filings

**What:** Get notified when Tesla files important documents with the SEC.

**Data source:** SEC EDGAR (checked every 24 hours)

**Logic:** We monitor Tesla's SEC filings feed for material documents: annual reports (10-K), quarterly reports (10-Q), current reports (8-K), and proxy statements. When a new filing appears, you get a notification with a direct link to the document.

**Example:** "Tesla 10-K filed: Annual Report"

---

### xStocks points

**What:** Track your xStocks reward points. Get notified when your balance increases.

**Data source:** xStocks (backed.fi) API (checked every 24 hours)

**Logic:** We check your points balance daily. If your total points increased since the last check, we send a notification with the amount earned and your new total.

**Example:** "You just received 1,200 xStocks points. (Total: 5,400)"

---

## Auto-Trading Strategies

Strategies are pre-programmed trading rules that execute automatically when specific conditions are met. Each strategy is tied to a token in your portfolio. When you enable a strategy, the system monitors for the trigger event and executes a trade through your smart account.

### Available Strategies for TSLAx

#### Sell on CEO departure

**What:** If Elon Musk tweets that he is stepping down, resigning, or is no longer CEO of Tesla, sell your entire TSLAx position for USDC.

**How it works:** When you enable this strategy, an Otomato workflow starts monitoring @elonmusk tweets in real-time. An AI filter evaluates each tweet for direct statements about leaving the CEO role. Speculation, jokes, and sarcasm are ignored. If a genuine CEO departure announcement is detected, the system immediately sells your TSLAx position via CoW Swap.

#### Auto-sell on dividend

**What:** When a dividend is distributed on TSLAx, automatically sell your position for USDC.

**How it works:** The system already monitors the TSLAx contract for dividend events (MultiplierUpdated). When a dividend fires and this strategy is active, it triggers a sell order.

#### Rebalance on 10% gain

**What:** When the TSLAx price increases by 10% or more in 24 hours, sell 50% of your position to lock in gains.

**How it works:** An Otomato workflow monitors the token price. When the threshold is crossed, it calls back to our server which executes a partial sell.

### Using Strategies

1. Create a smart account first (`POST /smart-account`)
2. Fund the smart account with TSLAx and ETH for gas
3. Browse available strategies: `GET /strategies`
4. Enable a strategy: `POST /strategies/enable` with `{"strategyId": "ceo-departure-sell", "tokenSymbol": "TSLAx"}`
5. The system monitors and executes automatically
6. You receive a push notification when a trade is executed
7. Disable anytime: `POST /strategies/disable`

### Strategy Execution Push Notification

When a strategy triggers a trade, you receive:

- **Type:** `strategy_executed`
- **Body:** "Strategy executed: Sold TSLAx -- CEO departure detected"
- **Data:** includes `strategyId`, `tokenSymbol`, `action` (sell/partial_sell), `reason`, and event-specific fields (tweet content, price change, etc.)

---

## Smart Account (ERC-4337)

The API supports on-chain execution through an ERC-4337 smart account on INK (chain 57073), powered by ZeroDev Kernel v3.1. A session key allows the backend to send transactions without the owner signing each one.

### Setup

1. Create a ZeroDev project for INK at [dashboard.zerodev.app](https://dashboard.zerodev.app)
2. Add to `.env`:
   ```
   ZERODEV_RPC=https://rpc.zerodev.app/api/v3/<project_id>/chain/57073
   OWNER_PRIVATE_KEY=0x...
   ```
3. Create a smart account: `POST /admin/create-smart-account`
4. Fund the smart account address with ETH on INK for gas

### Architecture

```
Owner EOA (OWNER_PRIVATE_KEY in .env)
  └─ Kernel Smart Account (counterfactual, deployed on first tx)
       ├─ sudo validator: owner ECDSA key (full control)
       └─ regular validator: session key (sudo policy, stored in DB)
```

The session key is serialized and stored alongside the smart account. All endpoints deserialize it on the fly to send UserOperations through the ZeroDev bundler.

### Endpoints

#### Smart Account Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/smart-account` | Bearer | Create smart account for the authenticated user |
| `GET` | `/smart-account` | Bearer | Get smart account address and chain |
| `POST` | `/admin/create-smart-account` | None | Create smart account for first/specified user |
| `GET` | `/admin/smart-accounts` | None | List all smart accounts |

#### Raw Transaction Execution

| Method | Path | Auth | Body |
|--------|------|------|------|
| `POST` | `/smart-account/execute` | Bearer | `{ to, value?, data? }` |
| `POST` | `/smart-account/execute-batch` | Bearer | `{ calls: [{ to, value?, data? }] }` |
| `POST` | `/admin/smart-account-execute` | None | `{ userId?, to, value?, data? }` |

#### CoW Swap (Presign)

Swaps go through CoW Protocol using the presign flow: the smart account approves the vault relayer and calls `setPreSignature` on the GPv2Settlement contract in a single batched UserOp. Solvers then fill the order off-chain.

| Method | Path | Auth | Body |
|--------|------|------|------|
| `POST` | `/smart-account/swap` | Bearer | `{ sellToken, buyToken, sellAmount, slippageBps?, validForSecs? }` |
| `GET` | `/smart-account/swap/:orderUid` | Bearer | Check order fill status |
| `POST` | `/admin/swap` | None | `{ sellToken?, buyToken?, sellAmount?, slippageBps?, validForSecs? }` |

**Defaults for `/admin/swap`:** USDC -> TSLAx, 10.5 USDC, 0.5% slippage, 1 hour validity.

**Example:**
```bash
# Swap 10.5 USDC to TSLAx with 0.5% slippage
curl -X POST http://localhost:3000/admin/swap \
  -H "Content-Type: application/json" \
  -d '{"sellAmount": "10500000"}'

# Check order status
curl http://localhost:3000/smart-account/swap/0x...orderUid \
  -H "Authorization: Bearer <token>"
```

**Token addresses on INK (57073):**

| Token | Address |
|-------|---------|
| USDC | `0x2D270e6886d130D724215A266106e6832161EAEd` |
| WETH | `0x4200000000000000000000000000000000000006` |
| TSLAx | `0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0` |

**Notes:**
- Amounts are in raw token decimals (USDC = 6 decimals, so 1 USDC = `1000000`)
- `slippageBps` is in basis points (50 = 0.5%, 100 = 1%)
- `validForSecs` controls how long the order stays open for solvers (default 3600 = 1 hour)
- On INK, CoW solvers need a minimum order size of ~$10 for TSLAx pairs

#### Tydro (AAVE Fork on INK)

Deposit and withdraw assets on Tydro. Deposits batch `approve` + `supply` in a single UserOp.

| Method | Path | Auth | Body |
|--------|------|------|------|
| `POST` | `/smart-account/tydro/deposit` | Bearer | `{ asset?, amount }` |
| `POST` | `/smart-account/tydro/withdraw` | Bearer | `{ asset?, amount }` |
| `POST` | `/admin/tydro-deposit` | None | `{ userId?, asset?, amount? }` |

**Defaults:** asset = USDC, amount = 1000000 (1 USDC).

**Example:**
```bash
# Deposit 5 USDC into Tydro
curl -X POST http://localhost:3000/admin/tydro-deposit \
  -H "Content-Type: application/json" \
  -d '{"amount": "5000000"}'
```

Tydro Pool: `0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA`

---

## Notification summary

| Notification | Trigger | Frequency | Source |
|---|---|---|---|
| Elon Musk tweets | New material tweet (AI-filtered) | Real-time | X (Twitter) + AI filter + AI summary |
| Price movement | >2.5% in 4h or >5% in 24h | Real-time | On-chain price |
| Earnings call | New date, 7 days before, 24h before | Every 6h | Alpha Vantage |
| Dividend | Multiplier updated on-chain | Real-time | Ethereum events |
| SEC filing | New 10-K, 10-Q, 8-K filed | Every 24h | SEC EDGAR |
| xStocks points | Balance increased | Every 24h | backed.fi API |
| Strategy executed | Auto-trade triggered | Real-time | Strategies engine |
