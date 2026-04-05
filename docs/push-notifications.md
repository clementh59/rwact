# Push Notification Payloads

All notifications are sent via Expo Push API. Each has a `type` field in `data` that the app uses to render the correct card.

---

## news

Triggered when a material tweet is detected from a monitored account (e.g. @elonmusk).

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "Elon Musk announces TSLAx Q1 earnings call on April 2nd",
  "data": {
    "type": "news",
    "data": {
      "ticker": "TSLAx",
      "source": "twitter",
      "entity": "Tesla",
      "summary": "Elon Musk announces TSLAx Q1 earnings call on April 2nd",
      "authorName": "Elon Musk",
      "authorHandle": "@elonmusk",
      "authorAvatar": "https://pbs.twimg.com/profile_images/1590968738358079488/IY9Gx6Ok_400x400.jpg",
      "content": "TSLAx Q1 earnings call is scheduled for April 2nd at 5pm ET. Big things coming!",
      "url": "https://x.com/elonmusk/status/1234567890"
    }
  }
}
```

---

## earning_call

Triggered when an earnings call is detected, 7 days before, and 24 hours before.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "TSLAx Q1 2026 earnings call in 2 days",
  "data": {
    "type": "earning_call",
    "data": {
      "token": "TSLAx",
      "eventTimestamp": 1775044721,
      "quarter": "Q1 2026",
      "estimatedEPS": 0.24
    }
  }
}
```

`estimatedEPS` is `null` when no consensus estimate is available.

---

## dividend

Triggered in real-time when a dividend is distributed on-chain.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "TSLAx dividend: 0.0050 per share (0.5%)",
  "data": {
    "type": "dividend",
    "data": {
      "ticker": "TSLAx",
      "contractAddress": "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
      "newMultiplier": 1.005,
      "dividendPerShare": 0.005,
      "dividendPct": 0.5,
      "transactionHash": "0x..."
    }
  }
}
```

`dividendPerShare` is in stock-relative terms. Multiply by current stock price for USD value.

---

## price_movement

Triggered when token price moves beyond threshold.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "TSLAx moved 3.2% in 4 hours",
  "data": {
    "type": "price_movement",
    "data": {
      "ticker": "TSLAx",
      "percentageChange": "3.2",
      "price": "285.50",
      "currency": "USD",
      "timePeriod": "4 hours"
    }
  }
}
```

---

## points

Triggered daily when xStocks points balance increases.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "You just received 1,200 xStocks points. (Total: 5,400)",
  "data": {
    "type": "points",
    "data": {
      "protocol": "xStocks",
      "amount": 1200,
      "total": 5400
    }
  }
}
```

---

## disclosure

Triggered when a new SEC filing is detected.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "Tesla 10-K filed: Annual Report",
  "data": {
    "type": "disclosure",
    "data": {
      "ticker": "TSLAx",
      "source": "sec_edgar",
      "form": "10-K",
      "date": "2026-01-29",
      "description": "10-K",
      "url": "https://www.sec.gov/Archives/edgar/data/1318605/..."
    }
  }
}
```

---

## strategy_executed

Triggered when an auto-trading strategy executes a trade.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "Otomato",
  "body": "Strategy executed: Sold TSLAx — CEO departure detected",
  "data": {
    "type": "strategy_executed",
    "data": {
      "strategyId": "ceo-departure-sell",
      "tokenSymbol": "TSLAx",
      "action": "sell",
      "reason": "CEO departure",
      "tweetContent": "I am stepping down as CEO of Tesla...",
      "tweetURL": "https://x.com/elonmusk/status/..."
    }
  }
}
```

For `rebalance-10pct-gain`, `action` is `"partial_sell"` and includes `percentageChange` and `price`.
For `autosell-dividends`, includes `dividendPerShare`, `dividendPct`, and `transactionHash`.
