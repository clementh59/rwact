# API Reference

Base URL: `https://freakish-nonissuably-natalia.ngrok-free.dev` (dev) or `http://localhost:3000`

All endpoints except `/register` require `Authorization: Bearer <token>` header.

---

## Authentication

### POST /register

Create a new user. Returns an auth token for all subsequent requests.

**Body:**
```json
{
  "address": "0x1C6892bf59Cec8241b215bb9bEA561b7294b052D",
  "expoPushToken": "ExponentPushToken[abc123]"
}
```

**Response (201):**
```json
{
  "token": "e12f8395-ed80-4050-a25d-da3f50dd120d",
  "userId": "abf00f0d-7e6b-4796-b8a9-8821e93fb390",
  "addresses": ["0x1C6892bf59Cec8241b215bb9bEA561b7294b052D"]
}
```

On registration, the server automatically:
1. Fetches portfolio from Debank
2. Detects xStocks tokens (e.g. TSLAx)
3. Creates Otomato workflows (X monitor, price alerts) with the user's push token baked in

---

## Portfolio

### GET /detect

Fetch full portfolio with monitoring data for all user wallets.

**Response:** Array of wallet objects. Each token matching the datapoints config gets a `monitoring` field injected:

```json
[
  {
    "address": "0x...",
    "protocols": [ ... ],
    "tokens": [
      {
        "id": "0x8ad3c73f...",
        "chain": "eth",
        "symbol": "TSLAx",
        "amount": 15.5,
        "price": 280.00,
        "monitoring": {
          "symbol": "TSLAx",
          "name": "Tesla xStock",
          "ticker": "TSLAx",
          "logoUrl": "https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.svg",
          "datapoints": [
            {
              "id": "major_news",
              "type": "news",
              "label": "Major news",
              "defaultEnabled": true,
              "items": [
                {
                  "id": "exec_social",
                  "label": "Get notified when Elon Musk posts",
                  "entity": "Elon Musk",
                  "icon": "elon_musk.jpg",
                  "source": "twitter",
                  "handle": "elonmusk",
                  "defaultEnabled": true
                }
              ]
            },
            {
              "id": "price_movement",
              "type": "market",
              "label": "Price movement",
              "defaultEnabled": true,
              "thresholds": [
                { "pct": 2.5, "window": "4h" },
                { "pct": 5, "window": "24h" }
              ]
            },
            { "id": "dividends", "type": "corporate_action", "label": "Dividend" },
            { "id": "earnings", "type": "corporate_action", "label": "Earnings calls" },
            { "id": "points", "type": "rewards", "label": "Points" }
          ]
        }
      }
    ]
  }
]
```

---

## Wallet Management

### POST /addAddress

Add a wallet address. Triggers portfolio scan and workflow creation for new tokens.

**Body:** `{"address": "0x..."}`

**Response:** `{"addresses": ["0x...", "0x..."]}`

### POST /removeAddress

Remove a wallet address.

**Body:** `{"address": "0x..."}`

**Response:** `{"addresses": ["0x..."]}`

---

## Workflows

### GET /workflows

List all Otomato workflows for the user.

**Response:**
```json
[
  {
    "workflowId": "52f43119-da08-4b05-a730-b6fcf9c4f651",
    "workflowName": "X Monitor: @elonmusk (TSLAx)",
    "datapointId": "major_news.exec_social",
    "tokenSymbol": "TSLAx",
    "state": "active"
  }
]
```

---

## Strategies

### GET /strategies

List all available auto-trading strategies for user's detected tokens.

**Response:**
```json
[
  {
    "id": "ceo-departure-sell",
    "name": "Sell on CEO departure",
    "description": "Sell your entire position if Elon Musk announces he is no longer CEO of Tesla.",
    "tokenSymbol": "TSLAx",
    "requiresSmartAccount": true,
    "enabled": false,
    "workflowId": null,
    "params": {}
  }
]
```

### POST /strategies/enable

**Body:** `{"strategyId": "ceo-departure-sell", "tokenSymbol": "TSLAx"}`

**Response:** `{"status": "enabled", "strategyId": "...", "workflowId": "..."}`

### POST /strategies/disable

**Body:** `{"strategyId": "ceo-departure-sell", "tokenSymbol": "TSLAx"}`

### GET /strategies/active

List user's currently enabled strategies.

---

## Smart Account

### POST /smart-account

Create an ERC-4337 smart account for the user (one-time).

**Response:** `{"smartAccountAddress": "0x...", "chainId": 57073}`

### GET /smart-account

Get user's smart account details.

### POST /smart-account/swap

Execute a CoW Swap.

**Body:**
```json
{
  "sellToken": "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
  "buyToken": "0x2D270e6886d130D724215A266106e6832161EAEd",
  "sellAmount": "10000000000000000000",
  "slippageBps": 50,
  "validForSecs": 3600
}
```

### GET /smart-account/swap/:orderUid

Check order fill status.

### POST /smart-account/tydro/deposit

Deposit into Tydro (AAVE fork).

**Body:** `{"asset": "0x...", "amount": "5000000"}`

### POST /smart-account/tydro/withdraw

Withdraw from Tydro.

**Body:** `{"asset": "0x...", "amount": "5000000"}`

---

## Webhook

### POST /webhook/strategy/:strategyId

Internal endpoint called by Otomato workflows when a strategy condition is met. Not called by the frontend directly.
