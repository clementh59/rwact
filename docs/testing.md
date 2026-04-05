# Testing Endpoints

All admin/test endpoints require no authentication. They exist for hackathon demo purposes.

---

## Users

### GET /admin/users

List all registered users with their addresses and workflow counts.

```json
[
  {
    "id": "abf00f0d-...",
    "authToken": "e12f8395-...",
    "expoPushToken": "ExponentPushToken[...]",
    "createdAt": "2026-04-01 12:54:46",
    "addresses": ["0x1C6892bf59..."],
    "workflows": 3
  }
]
```

---

## Push Notifications

### POST /admin/test-push

Send a test push notification to any user. Useful for testing how each notification type renders in the app.

**Body:**
```json
{
  "userId": "cb0d4ab4-...",
  "type": "news"
}
```

Available `type` values: `news`, `earning_call`, `points`, `dividend`, `price_movement`

Each sends a realistic sample payload. You can override the body text with `"body": "custom message"`.

You can also target by push token directly: `{"expoPushToken": "ExponentPushToken[...]", "type": "dividend"}`

---

## Earnings

### POST /admin/trigger-earnings

Manually trigger the earnings check for all stocks. Sends push notifications to all registered users.

**Response:** `{"pushTokens": 2, "results": [{"symbol": "TSLA", "status": "ok"}]}`

---

## Workflows

### POST /admin/test-x-workflow

Create a new 5-node X Monitor workflow (with AI filter + condition) for @elonmusk.

**Body:** `{"userId": "cb0d4ab4-..."}`

**Response:** `{"workflowId": "6d0b29f8-...", "workflowName": "X Monitor: @elonmusk (TSLAx)", "nodes": 5}`

---

## Strategies

### POST /admin/enable-strategy

Enable a strategy for a user (creates Otomato workflow if needed).

**Body:**
```json
{
  "userId": "cb0d4ab4-...",
  "strategyId": "ceo-departure-sell",
  "tokenSymbol": "TSLAx"
}
```

### POST /admin/test-strategy-webhook

Simulate a strategy trigger. Finds all users with the strategy enabled and attempts to execute trades.

**Body:**
```json
{
  "strategyId": "ceo-departure-sell",
  "tweetContent": "I am stepping down as CEO of Tesla effective immediately.",
  "tweetURL": "https://x.com/elonmusk/status/test"
}
```

For rebalance: `{"strategyId": "rebalance-10pct-gain", "percentageChange": "12.5", "price": "310.00"}`

---

## Smart Accounts

### POST /admin/create-smart-account

Create a smart account for the first (or specified) user.

**Body:** `{"userId": "cb0d4ab4-..."}` (optional, defaults to first user)

### GET /admin/smart-accounts

List all smart accounts.

### POST /admin/smart-account-execute

Execute a raw transaction from a user's smart account.

**Body:** `{"userId": "...", "to": "0x...", "value": "0", "data": "0x..."}`

### POST /admin/swap

Execute a CoW Swap with defaults (USDC -> TSLAx, 10.5 USDC).

**Body:** `{"sellToken": "...", "buyToken": "...", "sellAmount": "..."}` (all optional, has defaults)

### POST /admin/tydro-deposit

Deposit into Tydro with defaults (1 USDC).

**Body:** `{"userId": "...", "amount": "5000000"}` (optional)
