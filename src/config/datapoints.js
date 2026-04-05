/**
 * Token monitoring configuration for RWAct.
 * Maps xStocks token symbols to their on-chain addresses and the datapoints (news, price, dividends, earnings, points)
 * that trigger notifications for holders.
 */

const TOKEN_DATAPOINTS = {
  TSLAx: {
    name: "Tesla xStock",
    ticker: "TSLAx",
    stockSymbol: "TSLA",
    dividendContract: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", // Ethereum mainnet
    logoUrl: "https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.svg",
    addresses: [
      { address: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", chain: "ink" },
      { address: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", chain: "ethereum", chainId: 1 },
      { address: "0x43680abf18cf54898be84c6ef78241cfbd441883", chain: "ethereum", chainId: 1, wrapped: true },
    ],
    datapoints: [
      {
        id: "major_news",
        type: "news",
        label: "Major news",
        description: "Key announcements from Tesla and related entities",
        defaultEnabled: true,
        items: [
          {
            id: "exec_social",
            label: "Get notified when Elon Musk posts",
            entity: "Elon Musk",
            icon: "elon_musk.jpg",
            avatarUrl: "https://pbs.twimg.com/profile_images/1590968738358079488/IY9Gx6Ok_400x400.jpg",
            source: "twitter",
            handle: "elonmusk",
            defaultEnabled: true,
          },
          {
            id: "company_social",
            label: "Get notified when Tesla tweets",
            entity: "Tesla",
            icon: "tesla.jpg",
            avatarUrl: "https://pbs.twimg.com/profile_images/1337607516008501250/6Ggc4S5n_400x400.png",
            source: "twitter",
            handle: "Tesla",
            defaultEnabled: true,
          },
          {
            id: "company_blog",
            label: "Get notified when Tesla announces a major news",
            entity: "Tesla",
            icon: "tesla.jpg",
            source: "blog",
            url: "https://www.tesla.com/blog",
            defaultEnabled: true,
          },
          {
            id: "sec_filings",
            label: "Get notified when SEC publishes a Tesla filing",
            entity: "SEC",
            icon: "sec.jpg",
            source: "sec",
            defaultEnabled: true,
          },
        ],
      },
      {
        id: "price_movement",
        type: "market",
        label: "Price movement",
        description: "Significant price swings on the underlying equity",
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
        description: "Ex-dividend dates, amounts, and payment schedules",
        defaultEnabled: true,
      },
      {
        id: "earnings",
        type: "corporate_action",
        label: "Earnings calls",
        description: "Quarterly earnings releases, guidance, and call transcripts",
        defaultEnabled: true,
      },
      {
        id: "points",
        type: "rewards",
        label: "Points",
        description: "Points programs, airdrops, and reward campaigns",
        defaultEnabled: true,
      },
    ],
  },
};

/**
 * Look up a token config by contract address and chain ID.
 * @param {string} address - Contract address (case-insensitive)
 * @param {number} chainId
 * @returns {{ symbol: string, name: string, datapoints: object[] } | null}
 */
function findTokenByAddress(address, chainId) {
  const addr = address.toLowerCase();
  for (const [symbol, config] of Object.entries(TOKEN_DATAPOINTS)) {
    const match = config.addresses.find(
      (a) => a.address.toLowerCase() === addr && a.chainId === chainId
    );
    if (match) return { symbol, ...config };
  }
  return null;
}

/**
 * Resolve monitoring datapoints for a list of held tokens.
 * @param {{ address: string, chainId: number }[]} heldTokens
 * @returns {{ symbol: string, name: string, address: string, chainId: number, datapoints: object[] }[]}
 */
function resolveDatapoints(heldTokens) {
  const results = [];
  for (const { address, chainId } of heldTokens) {
    const token = findTokenByAddress(address, chainId);
    if (token) {
      results.push({
        symbol: token.symbol,
        name: token.name,
        address,
        chainId,
        datapoints: token.datapoints,
      });
    }
  }
  return results;
}

module.exports = { TOKEN_DATAPOINTS, findTokenByAddress, resolveDatapoints };
