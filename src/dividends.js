/**
 * On-chain dividend event subscription for RWAct.
 * Listens for MultiplierUpdated events on xStocks token contracts via WebSocket,
 * computes dividend deltas, sends push notifications, and triggers autosell strategies.
 */
const { ethers } = require("ethers");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Set by startDividendMonitor — used to resolve push tokens at notification time
let _DB = null;

// WebSocket RPCs for event subscriptions, HTTP RPCs for reads
const WS_ENDPOINTS = [
  "wss://ethereum-rpc.publicnode.com",
  "wss://eth.llamarpc.com",
];
const HTTP_ENDPOINTS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://eth-mainnet.public.blastapi.io",
];

const CONTRACT_ABI = [
  "event MultiplierUpdated(uint256 value)",
  "function multiplier() view returns (uint256)",
];

let wsIndex = 0;
let httpIndex = 0;
let wsProvider = null;
let httpProvider = null;
let subscriptions = []; // { contract, address, ticker, listener }

// Track previous multiplier per contract to compute dividend delta
const multiplierState = {}; // address → bigint (raw 18-decimal value)

/** Get or create the current WebSocket provider, connecting to the active RPC endpoint. */
function getWsProvider() {
  if (wsProvider) return wsProvider;
  try {
    wsProvider = new ethers.WebSocketProvider(WS_ENDPOINTS[wsIndex]);
    wsProvider.on("error", (err) => {
      console.error(`[dividends] WebSocket error on ${WS_ENDPOINTS[wsIndex]}:`, err.message);
      // Don't rotate here — health check will handle it
    });
    wsProvider.websocket?.on?.("error", () => {}); // suppress raw WS errors
  } catch (err) {
    console.error(`[dividends] Failed to create WS provider ${WS_ENDPOINTS[wsIndex]}:`, err.message);
    wsProvider = null;
  }
  return wsProvider;
}

/** Destroy the current WS provider and rotate to the next endpoint. */
function rotateWsProvider() {
  if (wsProvider) { try { wsProvider.destroy(); } catch (_) {} }
  wsProvider = null;
  wsIndex = (wsIndex + 1) % WS_ENDPOINTS.length;
  console.log(`[dividends] Rotating WS to ${WS_ENDPOINTS[wsIndex]}`);
  return getWsProvider();
}

function getHttpProvider() {
  if (httpProvider) return httpProvider;
  httpProvider = new ethers.JsonRpcProvider(HTTP_ENDPOINTS[httpIndex]);
  return httpProvider;
}

function rotateHttpProvider() {
  httpIndex = (httpIndex + 1) % HTTP_ENDPOINTS.length;
  httpProvider = new ethers.JsonRpcProvider(HTTP_ENDPOINTS[httpIndex]);
  return httpProvider;
}

/**
 * Execute an async function with HTTP RPC provider fallback across all configured endpoints.
 * @param {Function} fn - Async function receiving an ethers provider
 * @returns {Promise<*>}
 */
async function withHttpFallback(fn) {
  for (let i = 0; i < HTTP_ENDPOINTS.length; i++) {
    try {
      return await fn(getHttpProvider());
    } catch (err) {
      console.error(`[dividends] HTTP RPC error (${HTTP_ENDPOINTS[httpIndex]}):`, err.message);
      rotateHttpProvider();
    }
  }
  throw new Error("All HTTP RPC endpoints failed");
}

function getAllPushTokens() {
  if (!_DB) return [];
  return [...new Set(_DB.getAllUsers().map((u) => u.expoPushToken).filter(Boolean))];
}

async function sendPushToAll({ title, body, data }) {
  const tokens = getAllPushTokens();
  for (const to of tokens) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, title, body, data }),
    });
    const result = await res.json();
    console.log(`[dividends] Push sent: ${body}`, result.data?.status || "");
  }
}

/**
 * Read the current multiplier from the contract to establish a baseline.
 */
async function fetchCurrentMultiplier(address) {
  return withHttpFallback(async (prov) => {
    const contract = new ethers.Contract(address, CONTRACT_ABI, prov);
    return await contract.multiplier();
  });
}

/**
 * Subscribe to MultiplierUpdated events on a given xStocks contract.
 */
function subscribeToContract(address, ticker) {
  const setup = () => {
    const contract = new ethers.Contract(address, CONTRACT_ABI, getWsProvider());

    const listener = (value, event) => {
      const newMultiplierRaw = value;
      const newMultiplier = parseFloat(ethers.formatUnits(newMultiplierRaw, 18));
      const prevMultiplierRaw = multiplierState[address];

      console.log(`[dividends] MultiplierUpdated on ${ticker} (${address}): ${newMultiplier}`);
      console.log(`[dividends] tx: ${event.log.transactionHash}`);

      let dividendPerShare = null;
      let dividendPct = null;

      if (prevMultiplierRaw && prevMultiplierRaw > 0n) {
        const prevMultiplier = parseFloat(ethers.formatUnits(prevMultiplierRaw, 18));
        dividendPerShare = newMultiplier - prevMultiplier;
        dividendPct = ((newMultiplierRaw - prevMultiplierRaw) * 10000n / prevMultiplierRaw);
        dividendPct = Number(dividendPct) / 100; // percent with 2 decimal precision
        console.log(`[dividends] Dividend per share: ${dividendPerShare.toFixed(6)} (${dividendPct}%)`);
      }

      // Update stored multiplier
      multiplierState[address] = newMultiplierRaw;

      const bodyText = dividendPerShare !== null
        ? `${ticker} dividend: ${dividendPerShare.toFixed(4)} per share (${dividendPct}%)`
        : `${ticker} dividend detected! Multiplier updated to ${newMultiplier}`;

      sendPushToAll({
        title: "RWAct",
        body: bodyText,
        data: {
          type: "dividend",
          data: {
            ticker,
            contractAddress: address,
            newMultiplier,
            dividendPerShare,
            dividendPct,
            transactionHash: event.log.transactionHash,
          },
        },
      });

      // Trigger autosell-dividends strategy if any users have it enabled
      if (_DB) {
        const { handleDividendStrategy } = require("./strategies");
        handleDividendStrategy(_DB, { ticker, dividendPerShare, dividendPct, transactionHash: event.log.transactionHash });
      }
    };

    contract.on("MultiplierUpdated", listener);
    return { contract, listener };
  };

  let sub;
  try {
    sub = setup();
  } catch (err) {
    console.error(`[dividends] Failed initial subscribe for ${ticker}:`, err.message);
    rotateWsProvider();
    sub = setup();
  }

  subscriptions.push({ address, ticker, ...sub });
  console.log(`[dividends] Subscribed to MultiplierUpdated on ${ticker} (${address})`);
}

/**
 * Resubscribe all contracts after an RPC rotation.
 */
function resubscribeAll() {
  const old = [...subscriptions];
  subscriptions = [];
  for (const { contract, listener } of old) {
    try { contract.off("MultiplierUpdated", listener); } catch (_) {}
  }
  for (const { address, ticker } of old) {
    subscribeToContract(address, ticker);
  }
}

/**
 * Health check: poll latest block every 60s to detect dead connections.
 * If it fails, rotate RPC and resubscribe.
 */
function startHealthCheck() {
  setInterval(async () => {
    try {
      await getWsProvider().getBlockNumber();
    } catch (err) {
      console.error("[dividends] Health check failed, rotating WS:", err.message);
      rotateWsProvider();
      resubscribeAll();
    }
  }, 60_000);
}

/**
 * Start dividend monitoring for a list of xStocks contracts.
 *
 * @param {Array<{address: string, ticker: string}>} contracts
 */
async function startDividendMonitor(contracts, DB) {
  _DB = DB;
  // Fetch baseline multiplier for each contract
  for (const { address, ticker } of contracts) {
    try {
      const current = await fetchCurrentMultiplier(address);
      multiplierState[address] = current;
      console.log(`[dividends] Baseline multiplier for ${ticker}: ${ethers.formatUnits(current, 18)}`);
    } catch (err) {
      console.error(`[dividends] Could not fetch baseline for ${ticker}:`, err.message);
    }
  }

  for (const { address, ticker } of contracts) {
    subscribeToContract(address, ticker);
  }
  startHealthCheck();
  console.log(`[dividends] Monitoring ${contracts.length} contract(s) for MultiplierUpdated events`);
}

module.exports = { startDividendMonitor, subscribeToContract, multiplierState, subscriptions };
