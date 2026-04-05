## Inspiration

xStocks made stocks composable — you can now use AAPL as collateral on Euler, LP TSLA on Uniswap, or earn yield in a vault. That's incredibly powerful. But we noticed a massive gap: when you hold stocks on Robinhood or eToro, they babysit your positions for free — margin calls, earnings reminders, dividend notifications, price alerts. On-chain xStocks users get none of this. The tools got more powerful, but the UX didn't follow.

## What it does

RWAct babysits your xStocks positions across DeFi. Paste your wallet, and we auto-detect every xStock you hold — whether it's sitting in your wallet, used as collateral on Euler, or in a Uniswap LP. We then monitor everything and send push notifications when something matters: earnings calls, dividend reinvestments, liquidation risk, NAV deviations, xStocks points, SEC filings, and relevant news filtered by AI. Users can also react instantly through a secure ERC-4337 smart account — trade, earn yield, or deleverage in one tap.

## How we built it

- **Mobile app** (React Native) with a portfolio view showing all xStocks positions and a feed of alerts
- **Express server** with SQLite for user management and a matching engine that fetches portfolio data from DeBank, computes leverage/exposure, and matches tokens with the right monitoring workflows
- **Workflow management layer** powered by the open-source Otomato SDK — composable no-code workflows that poll Alpha Vantage for earnings, subscribe to on-chain MultiplierUpdated events for dividends, track xStocks points via API, monitor SEC EDGAR for filings, and filter Twitter through AI for relevance
- **Execution layer** built on ERC-4337 smart accounts (ZeroDev kernel) with a simplified API (/trade, /earn, /leverage) routing through Cowswap and Tydro for abstracted on-chain execution
- **Push notification infrastructure** delivering alerts via mobile push and Telegram

## Challenges we ran into

- Detecting xStocks positions across multiple DeFi protocols (Euler, Uniswap, vaults) required understanding each protocol's data model and normalizing positions into a unified view
- Building the dividend detection pipeline by subscribing to the MultiplierUpdated EVM event and computing per-share dividend amounts from on-chain data
- Filtering Twitter noise — making AI relevance filtering fast enough to feel real-time while being accurate enough to only surface what matters to a specific user's holdings
- Designing the ERC-4337 session key policies to allow automated strategies without compromising user security

## What we learned

The biggest insight: the gap between DeFi's power and its UX is not about interfaces — it's about notifications. CeFi apps are successful because they proactively reach out to users. DeFi expects users to check dashboards. Push notifications are the missing primitive that makes composable finance usable by normal people.

## What's next

- Expanding monitoring to cover more xStocks DeFi integrations as they launch
- Human-in-the-loop execution: "Your AAPL dividend just arrived — Reinvest / Cash out" directly from the notification
- Automated strategies via session keys — e.g., auto-sell on earnings volatility, auto-deleverage on health factor drop
