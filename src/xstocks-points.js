/**
 * xStocks points balance tracker for RWAct.
 * Polls the Backed.fi xDrop API daily for each registered wallet, detects point balance
 * increases, and sends push notifications when new points are earned.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

const XSTOCKS_HEADERS = {
  accept: "*/*",
  origin: "https://defi.xstocks.fi",
  referer: "https://defi.xstocks.fi/",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};

// In-memory: address → last known totalBalance
const pointsState = {};

/**
 * Fetch a URL with automatic retries on failure.
 * @param {string} url
 * @param {object} headers
 * @param {number} [maxRetries=3]
 * @param {number} [retryInterval=20000] - Milliseconds between retries
 * @returns {Promise<object>} Parsed JSON response
 */
async function fetchWithRetry(url, headers, maxRetries = 3, retryInterval = 20000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return await res.json();
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryInterval));
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, retryInterval));
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${url}`);
}

/**
 * Fetch xStocks xDrop dashboard data for a wallet address.
 * @param {string} walletAddress
 * @returns {Promise<object>} Dashboard data including total balance
 */
async function fetchXStocksPoints(walletAddress) {
  const url = `https://api.backed.fi/xdrop/api/v1/xdrop-user/${walletAddress}/dashboard`;
  return fetchWithRetry(url, XSTOCKS_HEADERS);
}

async function sendPush(pushToken, { title, body, data }) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: pushToken, title, body, data }),
  });
  const result = await res.json();
  console.log(`[xstocks-points] Push sent: ${body}`, result.data?.status || "");
  return result;
}

/**
 * Check xStocks points for a single address.
 * Sends a push if totalBalance increased since last check.
 */
async function checkPointsForAddress(address, pushToken) {
  let dashboard;
  try {
    dashboard = await fetchXStocksPoints(address);
  } catch (err) {
    // User not found or API error — skip silently
    if (err.message?.includes("User not found") || dashboard?.error) return;
    throw err;
  }

  if (dashboard?.error) return;

  // Extract total balance — adapt field name based on actual API response
  const totalBalance = dashboard.totalBalance ?? dashboard.total_balance ?? dashboard.points ?? dashboard.totalPoints ?? null;
  if (totalBalance === null || totalBalance === undefined) {
    console.log(`[xstocks-points] Could not find balance field for ${address}. Keys: ${Object.keys(dashboard).join(", ")}`);
    return;
  }

  const prev = pointsState[address];
  pointsState[address] = totalBalance;

  // First check — just store baseline, don't notify
  if (prev === undefined) {
    console.log(`[xstocks-points] Baseline for ${address}: ${totalBalance} points`);
    return;
  }

  // Notify if balance increased
  if (totalBalance > prev) {
    const increase = totalBalance - prev;
    await sendPush(pushToken, {
      title: "RWAct",
      body: `You just received ${increase.toLocaleString()} xStocks points. (Total: ${totalBalance.toLocaleString()})`,
      data: {
        type: "points",
        data: {
          protocol: "xStocks",
          amount: increase,
          total: totalBalance,
        },
      },
    });
  }
}

/**
 * Start the xStocks points monitoring loop.
 *
 * @param {object} users - In-memory users store (userId → user)
 */
function startPointsLoop(DB) {
  async function check() {
    // Build address → pushToken map
    const addressToToken = {};
    for (const user of DB.getAllUsers()) {
      if (!user.expoPushToken) continue;
      for (const addr of DB.getAddresses(user.id)) {
        if (!addressToToken[addr]) addressToToken[addr] = user.expoPushToken;
      }
    }

    const addresses = Object.keys(addressToToken);
    if (addresses.length === 0) return;
    console.log(`[xstocks-points] Checking points for ${addresses.length} address(es)...`);

    for (const address of addresses) {
      try {
        await checkPointsForAddress(address, addressToToken[address]);
      } catch (err) {
        console.error(`[xstocks-points] Error checking ${address}:`, err.message);
      }
    }
    console.log(`[xstocks-points] Check complete.`);
  }

  // First check after 10s (let users register first), then daily
  setTimeout(check, 10000);
  const intervalId = setInterval(check, CHECK_INTERVAL_MS);
  console.log(`[xstocks-points] Monitoring loop started (every 24h)`);
  return intervalId;
}

module.exports = { startPointsLoop, checkPointsForAddress, fetchXStocksPoints, pointsState };
