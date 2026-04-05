# Adding Support for More Stocks

All token configuration lives in `config/datapoints.js`. To add monitoring for a new xStocks token, add an entry to the `TOKEN_DATAPOINTS` object.

---

## Config Structure

```js
const TOKEN_DATAPOINTS = {
  TSLAx: {
    name: "Tesla xStock",          // Display name
    ticker: "TSLAx",               // Token ticker (used in notifications)
    stockSymbol: "TSLA",           // Underlying stock symbol (for Alpha Vantage earnings)
    dividendContract: "0x8ad3...", // Ethereum contract to monitor for MultiplierUpdated events
    logoUrl: "https://...",        // Token logo URL
    addresses: [                   // On-chain addresses where this token exists
      { address: "0x8ad3...", chain: "ink" },
      { address: "0x8ad3...", chain: "ethereum", chainId: 1 },
      { address: "0x4368...", chain: "ethereum", chainId: 1, wrapped: true },
    ],
    datapoints: [ ... ],          // What to monitor (see below)
  },
};
```

---

## Adding a New Token (e.g. AAPLx)

### 1. Add the config entry

```js
AAPLx: {
  name: "Apple xStock",
  ticker: "AAPLx",
  stockSymbol: "AAPL",
  dividendContract: "0x...",  // xStocks contract on Ethereum
  logoUrl: "https://xstocks-metadata.backed.fi/logos/tokens/AAPLx.svg",
  addresses: [
    { address: "0x...", chain: "ethereum", chainId: 1 },
  ],
  datapoints: [
    {
      id: "major_news",
      type: "news",
      label: "Major news",
      defaultEnabled: true,
      items: [
        {
          id: "ceo_social",
          label: "Get notified when Tim Cook posts",
          entity: "Tim Cook",
          icon: "tim_cook.jpg",
          avatarUrl: "https://pbs.twimg.com/...",
          source: "twitter",
          handle: "tim_cook",
          defaultEnabled: true,
        },
        {
          id: "company_blog",
          label: "Get notified when Apple announces a major news",
          entity: "Apple",
          icon: "apple.jpg",
          source: "blog",
          url: "https://www.apple.com/newsroom/",
          defaultEnabled: true,
        },
      ],
    },
    {
      id: "price_movement",
      type: "market",
      label: "Price movement",
      defaultEnabled: true,
      thresholds: [
        { pct: 2.5, window: "4h" },
        { pct: 5, window: "24h" },
      ],
    },
    {
      id: "dividends",
      type: "corporate_action",
      label: "Dividend",
      defaultEnabled: true,
    },
    {
      id: "earnings",
      type: "corporate_action",
      label: "Earnings calls",
      defaultEnabled: true,
    },
    {
      id: "points",
      type: "rewards",
      label: "Points",
      defaultEnabled: true,
    },
  ],
},
```

### 2. What happens automatically

Once the entry is in `TOKEN_DATAPOINTS`:

- **Portfolio detection**: When any user holds AAPLx, `/detect` returns the `monitoring` field with the datapoints config
- **Otomato workflows**: On registration or addAddress, if AAPLx is detected, the server creates:
  - X Monitor workflow for @tim_cook (AI-filtered)
  - Price alert workflows (2.5%/4h, 5%/24h)
- **Earnings monitoring**: Alpha Vantage is polled for AAPL earnings (via `stockSymbol`)
- **Dividend monitoring**: WebSocket subscription to `MultiplierUpdated` on the contract (via `dividendContract`)
- **SEC filings**: Currently hardcoded to Tesla (CIK). To add Apple, update `disclosures.js` with Apple's CIK (`0000320193`)
- **xStocks points**: Checked for all user addresses automatically
- **Portfolio sync**: 8h loop detects if user acquired/sold AAPLx and starts/stops workflows

### 3. What needs manual work

- **SEC disclosures**: Add the company's CIK to `disclosures.js` (currently Tesla-only)
- **Strategies**: Add `"AAPLx"` to `tokenSymbols` array in strategy templates in `strategies.js`
- **FE icons**: Add `tim_cook.jpg`, `apple.jpg` to the app's asset bundle

---

## Datapoint Types

| Type | What it controls |
|------|-----------------|
| `news` | X/Twitter monitoring. Has `items` array with individual accounts to track |
| `market` | Price movement alerts. Has `thresholds` array with `pct` and `window` |
| `corporate_action` | Earnings calls, dividends. No extra config needed |
| `rewards` | Points/airdrops. No extra config needed |

---

## How Token Detection Works

When Debank returns a user's portfolio (tokens + DeFi positions), the server:

1. Iterates every token in wallet holdings and every token inside DeFi positions (supply, borrow, reward, LP)
2. Compares each token's `address` + `chainId` against all entries in `TOKEN_DATAPOINTS`
3. If a match is found, injects the `monitoring` field into that token's response
4. Creates Otomato workflows for any new matches not already tracked

The matching is done by `findTokenByAddress(address, chainId)` in `config/datapoints.js`.
