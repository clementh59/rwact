/**
 * RWAct Express server — portfolio-aware notification backend for xStocks tokenized equities.
 * Handles user registration, wallet management, DeBank portfolio detection, Otomato workflow
 * lifecycle, smart account operations (ERC-4337), auto-trading strategies, and admin endpoints.
 */
require("dotenv").config();

// Prevent WebSocket / RPC errors from crashing the process
process.on("uncaughtException", (err) => {
  console.error("[uncaught]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandled]", err?.message || err);
});

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const app = express();

app.use(express.json());

const { DEBANK_API_KEY, PORT = 3000 } = process.env;
if (!DEBANK_API_KEY) {
  throw new Error("DEBANK_API_KEY is required in .env");
}

const { findTokenByAddress, TOKEN_DATAPOINTS } = require("./config/datapoints");
const { createWorkflowsForToken, createSmartAccountWorkflow } = require("./workflows");
const { startSyncLoop } = require("./sync");
const { startEarningsLoop } = require("./earnings");
const { startPointsLoop } = require("./xstocks-points");
const { startDividendMonitor } = require("./dividends");
const { startDisclosureLoop } = require("./disclosures");
const {
  STRATEGY_TEMPLATES, getTemplatesForToken,
  createCeoDepartureWorkflow, createRebalanceWorkflow,
  handleStrategyWebhook, handleDividendStrategy,
  setSwapExecutor,
} = require("./strategies");
const DB = require("./db");

// --- Auth middleware ---

/** Express middleware: extract Bearer token, resolve user, attach to req.user. */
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "unauthorized" });

  const user = DB.getUserByToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  user.addresses = DB.getAddresses(user.id);
  req.user = user;
  next();
}

// --- Debank helpers ---

const DEBANK_BASE = "https://pro-openapi.debank.com/v1/user";
const debankHeaders = { AccessKey: DEBANK_API_KEY, Accept: "application/json" };

/**
 * Fetch all protocol positions and token balances for an address via DeBank.
 * @param {string} address - EVM wallet address
 * @returns {Promise<{ address: string, protocols: object[], tokens: object[] }>}
 */
async function fetchForAddress(address) {
  const [protocols, tokens] = await Promise.all([
    fetch(`${DEBANK_BASE}/all_complex_protocol_list?id=${address}`, { headers: debankHeaders }).then((r) => r.json()),
    fetch(`${DEBANK_BASE}/all_token_list?id=${address}`, { headers: debankHeaders }).then((r) => r.json()),
  ]);
  return { address, protocols: Array.isArray(protocols) ? protocols : [], tokens: Array.isArray(tokens) ? tokens : [] };
}

/** Annotate DeBank position data with monitoring config for any recognized xStocks tokens. */
function enrichWithMonitoring(allPositions) {
  for (const entry of allPositions) {
    for (const t of entry.tokens) {
      const match = findTokenByAddress(t.id, chainToId(t.chain));
      if (match) t.monitoring = monitoringPayload(match);
    }
    for (const proto of entry.protocols) {
      for (const item of proto.portfolio_item_list || []) {
        for (const key of ["supply_token_list", "borrow_token_list", "reward_token_list", "token_list"]) {
          for (const t of item.detail?.[key] || []) {
            const match = findTokenByAddress(t.id, chainToId(t.chain));
            if (match) t.monitoring = monitoringPayload(match);
          }
        }
      }
    }
  }
  return allPositions;
}

/** Extract deduplicated monitoring configs from enriched position data. */
function extractMonitoringConfigs(allPositions) {
  const seen = new Set();
  const configs = [];
  for (const entry of allPositions) {
    for (const t of entry.tokens) {
      if (t.monitoring && !seen.has(t.monitoring.symbol)) {
        seen.add(t.monitoring.symbol);
        configs.push(t.monitoring);
      }
    }
    for (const proto of entry.protocols) {
      for (const item of proto.portfolio_item_list || []) {
        for (const key of ["supply_token_list", "borrow_token_list", "reward_token_list", "token_list"]) {
          for (const t of item.detail?.[key] || []) {
            if (t.monitoring && !seen.has(t.monitoring.symbol)) {
              seen.add(t.monitoring.symbol);
              configs.push(t.monitoring);
            }
          }
        }
      }
    }
  }
  return configs;
}

const DEBANK_CHAIN_MAP = {
  eth: 1, arb: 42161, base: 8453, op: 10, bsc: 56, matic: 137,
  avax: 43114, ftm: 250, xdai: 100, cro: 25, hmy: 1666600000,
};

/** Convert a DeBank chain slug (e.g. "eth", "arb") to a numeric chain ID. */
function chainToId(debankChain) {
  return DEBANK_CHAIN_MAP[debankChain] || debankChain;
}

/** Build a slim monitoring payload from a matched token config for API responses. */
function monitoringPayload(match) {
  return {
    symbol: match.symbol,
    name: match.name,
    ticker: match.ticker,
    logoUrl: match.logoUrl,
    datapoints: match.datapoints,
  };
}

/**
 * Detect xStocks tokens in a user's wallet and create notification workflows for any new ones.
 * @param {string} userId
 * @param {string[]} addresses - Wallet addresses to scan
 * @returns {Promise<{ allPositions: object[], newWorkflows: object[] }>}
 */
async function detectAndCreateWorkflows(userId, addresses) {
  const user = DB.getUserById(userId);
  const allPositions = await Promise.all(addresses.map(fetchForAddress));
  enrichWithMonitoring(allPositions);
  const configs = extractMonitoringConfigs(allPositions);

  const existingSymbols = new Set(DB.getWorkflowSymbols(userId));
  const newWorkflows = [];

  for (const monitoring of configs) {
    if (existingSymbols.has(monitoring.symbol)) continue;

    const fullConfig = TOKEN_DATAPOINTS[monitoring.symbol];
    if (fullConfig) monitoring.addresses = fullConfig.addresses;

    try {
      const created = await createWorkflowsForToken(monitoring, user.expoPushToken);
      for (const wf of created) {
        DB.addWorkflow(userId, { ...wf, tokenSymbol: monitoring.symbol, state: "active" });
        newWorkflows.push(wf);
      }
    } catch (err) {
      console.error(`Failed to create workflows for ${monitoring.symbol}:`, err.message);
    }
  }

  return { allPositions, newWorkflows };
}

// --- Routes ---

app.post("/register", async (req, res) => {
  const { address, expoPushToken } = req.body;
  if (!address) {
    return res.status(400).json({ error: "address is required in body" });
  }
  if (!expoPushToken) {
    return res.status(400).json({ error: "expoPushToken is required in body" });
  }

  const id = uuidv4();
  const token = uuidv4();
  DB.createUser(id, token, expoPushToken);
  DB.addAddress(id, address);

  // Detect & create workflows in background
  detectAndCreateWorkflows(id, [address]).then(({ newWorkflows }) => {
    if (newWorkflows.length) console.log(`Created ${newWorkflows.length} workflows for user ${id}`);
  });

  res.status(201).json({ token, userId: id, addresses: [address] });
});

app.get("/detect", auth, async (req, res) => {
  const { addresses } = req.user;
  if (addresses.length === 0) {
    return res.json([]);
  }

  try {
    const allPositions = await Promise.all(addresses.map(fetchForAddress));
    enrichWithMonitoring(allPositions);
    res.json(allPositions);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "failed to fetch from Debank" });
  }
});

app.post("/addAddress", auth, async (req, res) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: "address is required in body" });
  }
  if (DB.hasAddress(req.user.id, address)) {
    return res.status(409).json({ error: "address already added" });
  }

  DB.addAddress(req.user.id, address);
  const addresses = DB.getAddresses(req.user.id);

  // Detect & create workflows for the new address
  detectAndCreateWorkflows(req.user.id, [address]).then(({ newWorkflows }) => {
    if (newWorkflows.length) console.log(`Created ${newWorkflows.length} workflows for new address ${address}`);
  });

  res.json({ addresses });
});

app.post("/removeAddress", auth, (req, res) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: "address is required in body" });
  }

  const removed = DB.removeAddress(req.user.id, address);
  if (!removed) {
    return res.status(404).json({ error: "address not found" });
  }

  res.json({ addresses: DB.getAddresses(req.user.id) });
});

app.get("/workflows", auth, (req, res) => {
  res.json(DB.getWorkflows(req.user.id));
});

// --- Smart Account endpoints ---

// Lazy-load ESM smart-account module
let _smartAccount;
/** Lazy-load the ESM smart-account module (requires ZERODEV_RPC). */
async function getSmartAccountModule() {
  if (!_smartAccount) {
    if (!process.env.ZERODEV_RPC) {
      throw new Error("ZERODEV_RPC not configured — smart account features disabled");
    }
    _smartAccount = await import("./smart-account.mjs");
  }
  return _smartAccount;
}

app.post("/smart-account", auth, async (req, res) => {
  try {
    const existing = DB.getSmartAccountForUser(req.user.id);
    if (existing) {
      return res.json({
        smartAccountAddress: existing.smartAccountAddress,
        chainId: existing.chainId,
        message: "smart account already exists",
      });
    }

    const sa = await getSmartAccountModule();
    const result = await sa.createSmartAccountWithSessionKey();

    DB.addSmartAccount(req.user.id, {
      smartAccountAddress: result.smartAccountAddress,
      ownerPrivateKey: result.ownerPrivateKey,
      sessionPrivateKey: result.sessionPrivateKey,
      serializedSessionKey: result.serializedSessionKey,
    });

    res.status(201).json({
      smartAccountAddress: result.smartAccountAddress,
      chainId: 57073,
      message: "smart account created on INK",
    });
  } catch (err) {
    console.error("Smart account creation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/smart-account", auth, (req, res) => {
  const account = DB.getSmartAccountForUser(req.user.id);
  if (!account) return res.status(404).json({ error: "no smart account" });

  res.json({
    smartAccountAddress: account.smartAccountAddress,
    chainId: account.chainId,
    createdAt: account.createdAt,
  });
});

app.post("/smart-account/execute", auth, async (req, res) => {
  const { to, value, data } = req.body;
  if (!to) return res.status(400).json({ error: "to is required" });

  const account = DB.getSmartAccountForUser(req.user.id);
  if (!account) return res.status(404).json({ error: "no smart account — create one first" });

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.sendTransaction(
      account.serializedSessionKey,
      account.sessionPrivateKey,
      { to, value: value || "0", data: data || "0x" }
    );
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Smart account tx failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/smart-account/execute-batch", auth, async (req, res) => {
  const { calls } = req.body;
  if (!Array.isArray(calls) || calls.length === 0) {
    return res.status(400).json({ error: "calls[] is required" });
  }

  const account = DB.getSmartAccountForUser(req.user.id);
  if (!account) return res.status(404).json({ error: "no smart account" });

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.sendBatchTransactions(
      account.serializedSessionKey,
      account.sessionPrivateKey,
      calls
    );
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Smart account batch tx failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Tydro (AAVE fork on INK) endpoints ---

app.post("/smart-account/tydro/deposit", auth, async (req, res) => {
  const { asset, amount } = req.body;
  if (!amount) return res.status(400).json({ error: "amount is required" });

  const account = DB.getSmartAccountForUser(req.user.id);
  if (!account) return res.status(404).json({ error: "no smart account" });

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.tydroDeposit(
      account.serializedSessionKey,
      account.sessionPrivateKey,
      { asset, amount }
    );
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Tydro deposit failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/smart-account/tydro/withdraw", auth, async (req, res) => {
  const { asset, amount } = req.body;
  if (!amount) return res.status(400).json({ error: "amount is required" });

  const account = DB.getSmartAccountForUser(req.user.id);
  if (!account) return res.status(404).json({ error: "no smart account" });

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.tydroWithdraw(
      account.serializedSessionKey,
      account.sessionPrivateKey,
      { asset, amount }
    );
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Tydro withdraw failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- CoW Swap endpoints ---

let _cowSwap;
async function getCowSwapModule() {
  if (!_cowSwap) _cowSwap = await import("../scripts/cow-swap.mjs");
  return _cowSwap;
}

async function getCowDeps() {
  const sa = await getSmartAccountModule();
  return { publicClient: sa.publicClient, makeKernelClient: sa.makeKernelClient, USE_PAYMASTER: sa.USE_PAYMASTER };
}

app.post("/smart-account/swap", auth, async (req, res) => {
  const { sellToken, buyToken, sellAmount, slippageBps, validForSecs } = req.body;
  if (!sellToken || !buyToken || !sellAmount) {
    return res.status(400).json({ error: "sellToken, buyToken, sellAmount required" });
  }

  const account = DB.getSmartAccountForUser(req.user.id);
  if (!account) return res.status(404).json({ error: "no smart account" });

  try {
    const cow = await getCowSwapModule();
    const deps = await getCowDeps();
    const result = await cow.cowSwap({
      serializedSessionKey: account.serializedSessionKey,
      sessionPrivateKey: account.sessionPrivateKey,
      ownerPrivateKey: account.ownerPrivateKey,
      smartAccountAddress: account.smartAccountAddress,
      sellToken, buyToken, sellAmount,
      slippageBps: slippageBps || 50,
      validForSecs: validForSecs || 3600,
    }, deps);
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("CoW swap failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/smart-account/swap/:orderUid", auth, async (req, res) => {
  try {
    const cow = await getCowSwapModule();
    const status = await cow.getOrderStatus(req.params.orderUid);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Strategy endpoints ---

app.get("/strategies", auth, (req, res) => {
  // Get all templates for user's detected tokens + user's activation status
  const userStrategies = DB.getStrategiesForUser(req.user.id);
  const activeMap = {};
  for (const s of userStrategies) {
    activeMap[`${s.strategyId}:${s.tokenSymbol}`] = s;
  }

  // Find which tokens the user holds that have strategies
  const tokens = [...new Set(DB.getWorkflows(req.user.id).map((w) => w.tokenSymbol))];
  const result = [];
  for (const token of tokens) {
    const templates = getTemplatesForToken(token);
    for (const tmpl of templates) {
      const key = `${tmpl.id}:${token}`;
      const userState = activeMap[key];
      result.push({
        ...tmpl,
        tokenSymbol: token,
        enabled: userState ? !!userState.enabled : false,
        workflowId: userState?.workflowId || null,
      });
    }
  }
  res.json(result);
});

app.post("/strategies/enable", auth, async (req, res) => {
  const { strategyId, tokenSymbol } = req.body;
  if (!strategyId || !tokenSymbol) {
    return res.status(400).json({ error: "strategyId and tokenSymbol required" });
  }
  const template = STRATEGY_TEMPLATES[strategyId];
  if (!template) return res.status(404).json({ error: "unknown strategy" });

  if (template.requiresSmartAccount && !DB.getSmartAccountForUser(req.user.id)) {
    return res.status(400).json({ error: "smart account required — create one first via POST /smart-account" });
  }

  // Check if already enabled
  const existing = DB.getStrategy(req.user.id, strategyId, tokenSymbol);
  if (existing?.enabled) {
    return res.json({ status: "already_enabled", strategyId, tokenSymbol });
  }

  let workflowId = null;

  // Create Otomato workflow if needed
  if (strategyId === "ceo-departure-sell") {
    const webhookUrl = `${req.protocol}://${req.get("host")}/webhook/strategy/ceo-departure-sell`;
    const wf = await createCeoDepartureWorkflow(webhookUrl, req.user.expoPushToken);
    workflowId = wf.id;
  } else if (strategyId === "rebalance-10pct-gain") {
    const webhookUrl = `${req.protocol}://${req.get("host")}/webhook/strategy/rebalance-10pct-gain`;
    const tslax = TOKEN_DATAPOINTS.TSLAx;
    const addr = tslax.addresses.find((a) => a.chainId === 1);
    const wf = await createRebalanceWorkflow(webhookUrl, addr.address, addr.chainId);
    workflowId = wf.id;
  }
  // autosell-dividends doesn't need a workflow — hooks into existing dividend monitor

  DB.enableStrategy(req.user.id, strategyId, tokenSymbol, template.params, workflowId);
  res.json({ status: "enabled", strategyId, tokenSymbol, workflowId });
});

app.post("/strategies/disable", auth, (req, res) => {
  const { strategyId, tokenSymbol } = req.body;
  if (!strategyId || !tokenSymbol) {
    return res.status(400).json({ error: "strategyId and tokenSymbol required" });
  }

  DB.disableStrategy(req.user.id, strategyId, tokenSymbol);

  // TODO: stop the Otomato workflow if one was created
  res.json({ status: "disabled", strategyId, tokenSymbol });
});

app.get("/strategies/active", auth, (req, res) => {
  res.json(DB.getEnabledStrategiesForUser(req.user.id));
});

// --- Strategy webhook (called by Otomato workflows) ---

app.post("/webhook/strategy/:strategyId", async (req, res) => {
  const { strategyId } = req.params;
  const { tokenSymbol, ...eventData } = req.body;

  console.log(`[webhook] Strategy ${strategyId} triggered for ${tokenSymbol || "TSLAx"}`);

  try {
    const results = await handleStrategyWebhook(DB, {
      strategyId,
      tokenSymbol: tokenSymbol || "TSLAx",
      ...eventData,
    });
    res.json({ executed: results.length, results });
  } catch (err) {
    console.error(`[webhook] Strategy execution failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// --- Admin / Test endpoints (no auth, for hackathon testing) ---

app.get("/admin/users", (req, res) => {
  const users = DB.getAllUsers().map((u) => ({
    ...u,
    addresses: DB.getAddresses(u.id),
    workflows: DB.getWorkflows(u.id).length,
  }));
  res.json(users);
});

app.post("/admin/test-push", async (req, res) => {
  const { userId, type, body: pushBody } = req.body;
  const user = userId ? DB.getUserById(userId) : null;
  const token = user?.expoPushToken || req.body.expoPushToken;
  if (!token) return res.status(400).json({ error: "userId or expoPushToken required" });

  const payloads = {
    news: {
      title: "RWAct",
      body: pushBody || "Elon Musk tweets about TSLAx Q1 earnings",
      data: {
        type: "news",
        data: {
          ticker: "TSLAx", source: "twitter", entity: "Tesla",
          summary: "Elon Musk announces TSLAx Q1 earnings call on April 2nd",
          authorName: "Elon Musk", authorHandle: "@elonmusk",
          authorAvatar: "https://pbs.twimg.com/profile_images/1590968738358079488/IY9Gx6Ok_400x400.jpg",
          content: "TSLAx Q1 earnings call is scheduled for April 2nd at 5pm ET. Big things coming!",
          url: "https://x.com/elonmusk/status/1234567890",
        },
      },
    },
    earning_call: {
      title: "RWAct",
      body: pushBody || "TSLAx Q1 2026 earnings call in 2 days",
      data: {
        type: "earning_call",
        data: {
          token: "TSLAx", eventTimestamp: Math.floor(Date.now() / 1000) + 172800,
          quarter: "Q1 2026", estimatedEPS: 0.24,
        },
      },
    },
    points: {
      title: "RWAct",
      body: pushBody || "You just received 1,200 xStocks points. (Total: 5,400)",
      data: { type: "points", data: { protocol: "xStocks", amount: 1200, total: 5400 } },
    },
    dividend: {
      title: "RWAct",
      body: pushBody || "TSLAx dividend: 0.0050 per share (0.5%)",
      data: {
        type: "dividend",
        data: { ticker: "TSLAx", contractAddress: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", newMultiplier: 1.005, dividendPerShare: 0.005, dividendPct: 0.5, transactionHash: "0xtest" },
      },
    },
    price_movement: {
      title: "RWAct",
      body: pushBody || "TSLAx moved 3.2% in 4 hours",
      data: {
        type: "price_movement",
        data: { ticker: "TSLAx", percentageChange: "3.2", price: "285.50", currency: "USD", timePeriod: "4 hours" },
      },
    },
  };

  const payload = payloads[type || "news"];
  try {
    const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: token, ...payload }),
    });
    const result = await pushRes.json();
    res.json({ sent: true, to: token, type: type || "news", result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/create-smart-account", async (req, res) => {
  const { userId } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  const existing = DB.getSmartAccountForUser(user.id);
  if (existing) {
    return res.json({
      smartAccountAddress: existing.smartAccountAddress,
      chainId: existing.chainId,
      message: "already exists",
    });
  }

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.createSmartAccountWithSessionKey();

    DB.addSmartAccount(user.id, {
      smartAccountAddress: result.smartAccountAddress,
      ownerPrivateKey: result.ownerPrivateKey,
      sessionPrivateKey: result.sessionPrivateKey,
      serializedSessionKey: result.serializedSessionKey,
    });

    res.status(201).json({
      userId: user.id,
      smartAccountAddress: result.smartAccountAddress,
      chainId: 57073,
    });
  } catch (err) {
    console.error("Admin smart account creation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/smart-account-execute", async (req, res) => {
  const { userId, to, value, data } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  const account = DB.getSmartAccountForUser(user.id);
  if (!account) return res.status(404).json({ error: "no smart account for this user" });

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.sendTransaction(
      account.serializedSessionKey,
      account.sessionPrivateKey,
      { to: to || "0x0000000000000000000000000000000000000000", value: value || "0", data: data || "0x" }
    );
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Admin smart account tx failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/smart-accounts", (req, res) => {
  const users = DB.getAllUsers();
  const accounts = [];
  for (const u of users) {
    const sa = DB.getSmartAccountForUser(u.id);
    if (sa) {
      accounts.push({
        userId: u.id,
        smartAccountAddress: sa.smartAccountAddress,
        chainId: sa.chainId,
        createdAt: sa.createdAt,
      });
    }
  }
  res.json(accounts);
});

app.post("/admin/create-smart-account-oa", async (req, res) => {
  const { userId, apiBaseUrl, to, value, data, percentageChange, timePeriod } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  const account = DB.getSmartAccountForUser(user.id);
  if (!account) return res.status(404).json({ error: "create a smart account first" });

  const tslax = TOKEN_DATAPOINTS.TSLAx;
  const addr = tslax.addresses.find((a) => a.chainId === 1);
  if (!addr) return res.status(500).json({ error: "no TSLAx address with chainId" });

  try {
    const wf = await createSmartAccountWorkflow({
      apiBaseUrl: apiBaseUrl || `http://localhost:${PORT}`,
      authToken: user.authToken,
      tokenName: tslax.ticker,
      contractAddress: addr.address,
      chainId: addr.chainId,
      percentageChange: percentageChange || 2.5,
      timePeriod: timePeriod || "4 hours",
      tx: {
        to: to || "0x0000000000000000000000000000000000000000",
        value: value || "0",
        data: data || "0x",
      },
      expoPushToken: user.expoPushToken,
    });

    DB.addWorkflow(user.id, {
      workflowId: wf.id,
      workflowName: wf.name,
      datapointId: "smart_account_tx",
      tokenSymbol: tslax.ticker,
      state: "active",
    });

    res.status(201).json({
      workflowId: wf.id,
      workflowName: wf.name,
      smartAccountAddress: account.smartAccountAddress,
      trigger: `${tslax.ticker} >${percentageChange || 2.5}% in ${timePeriod || "4 hours"}`,
    });
  } catch (err) {
    console.error("Failed to create smart account OA:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/swap", async (req, res) => {
  const { userId, sellToken, buyToken, sellAmount, slippageBps, validForSecs } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  const account = DB.getSmartAccountForUser(user.id);
  if (!account) return res.status(404).json({ error: "create smart account first" });

  try {
    const cow = await getCowSwapModule();
    const deps = await getCowDeps();
    const result = await cow.cowSwap({
      serializedSessionKey: account.serializedSessionKey,
      sessionPrivateKey: account.sessionPrivateKey,
      ownerPrivateKey: account.ownerPrivateKey,
      smartAccountAddress: account.smartAccountAddress,
      sellToken: sellToken || "0x2D270e6886d130D724215A266106e6832161EAEd",
      buyToken: buyToken || "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
      sellAmount: sellAmount || "10500000",
      slippageBps: slippageBps || 50,
      validForSecs: validForSecs || 3600,
    }, deps);
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Admin swap failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/tydro-deposit", async (req, res) => {
  const { userId, asset, amount } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  const account = DB.getSmartAccountForUser(user.id);
  if (!account) return res.status(404).json({ error: "create smart account first" });

  try {
    const sa = await getSmartAccountModule();
    const result = await sa.tydroDeposit(
      account.serializedSessionKey,
      account.sessionPrivateKey,
      { asset, amount: amount || "1000000" } // default 1 USDC (6 decimals)
    );
    res.json({ ...result, smartAccountAddress: account.smartAccountAddress });
  } catch (err) {
    console.error("Admin tydro deposit failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/test-x-workflow", async (req, res) => {
  const { createXMonitorWorkflow } = require("./workflows");
  const { userId } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  try {
    const wf = await createXMonitorWorkflow({
      username: "elonmusk",
      tokenName: "TSLAx",
      entity: "Tesla",
      authorAvatar: "https://pbs.twimg.com/profile_images/1590968738358079488/IY9Gx6Ok_400x400.jpg",
      expoPushToken: user.expoPushToken,
    });
    DB.addWorkflow(user.id, { workflowId: wf.id, workflowName: wf.name, datapointId: "major_news.exec_social", tokenSymbol: "TSLAx", state: "active" });
    res.json({ workflowId: wf.id, workflowName: wf.name, nodes: wf.nodes.length });
  } catch (err) {
    console.error("Test X workflow failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/test-strategy-webhook", async (req, res) => {
  const { strategyId, tokenSymbol, tweetContent, tweetURL, account, timestamp, percentageChange, price } = req.body;
  try {
    const results = await handleStrategyWebhook(DB, {
      strategyId: strategyId || "ceo-departure-sell",
      tokenSymbol: tokenSymbol || "TSLAx",
      tweetContent: tweetContent || "I am stepping down as CEO of Tesla effective immediately. It has been an incredible journey.",
      tweetURL: tweetURL || "https://x.com/elonmusk/status/test",
      account: account || "elonmusk",
      timestamp: timestamp || new Date().toISOString(),
      percentageChange: percentageChange || "12.5",
      price: price || "310.00",
    });
    res.json({ results });
  } catch (err) {
    console.error("Test strategy webhook failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/enable-strategy", async (req, res) => {
  const { userId, strategyId, tokenSymbol } = req.body;
  const user = userId ? DB.getUserById(userId) : DB.getAllUsers()[0];
  if (!user) return res.status(400).json({ error: "no user found" });

  const template = STRATEGY_TEMPLATES[strategyId || "ceo-departure-sell"];
  if (!template) return res.status(404).json({ error: "unknown strategy" });

  const token = tokenSymbol || "TSLAx";
  let workflowId = null;

  try {
    if (template.id === "ceo-departure-sell") {
      const ngrokUrl = req.get("host").includes("ngrok") ? `https://${req.get("host")}` : `http://${req.get("host")}`;
      const wf = await createCeoDepartureWorkflow(`${ngrokUrl}/webhook/strategy/ceo-departure-sell`, user.expoPushToken);
      workflowId = wf.id;
    } else if (template.id === "rebalance-10pct-gain") {
      const ngrokUrl = req.get("host").includes("ngrok") ? `https://${req.get("host")}` : `http://${req.get("host")}`;
      const tslax = TOKEN_DATAPOINTS.TSLAx;
      const addr = tslax.addresses.find((a) => a.chainId === 1);
      const wf = await createRebalanceWorkflow(`${ngrokUrl}/webhook/strategy/rebalance-10pct-gain`, addr.address, addr.chainId);
      workflowId = wf.id;
    }

    DB.enableStrategy(user.id, template.id, token, template.params, workflowId);
    res.json({ status: "enabled", userId: user.id, strategyId: template.id, tokenSymbol: token, workflowId });
  } catch (err) {
    console.error("Admin enable strategy failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/trigger-earnings", async (req, res) => {
  const { checkEarningsForSymbol } = require("./earnings");
  const pushTokens = [...new Set(DB.getAllUsers().map((u) => u.expoPushToken).filter(Boolean))];
  const stocks = Object.values(TOKEN_DATAPOINTS).filter((t) => t.stockSymbol);
  const results = [];
  for (const t of stocks) {
    try {
      await checkEarningsForSymbol(t.stockSymbol, t.ticker, pushTokens);
      results.push({ symbol: t.stockSymbol, status: "ok" });
    } catch (err) {
      results.push({ symbol: t.stockSymbol, status: "error", error: err.message });
    }
  }
  res.json({ pushTokens: pushTokens.length, results });
});

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);

  // Wire strategy swap executor
  setSwapExecutor(async (params) => {
    const cow = await getCowSwapModule();
    const deps = await getCowDeps();
    return cow.cowSwap(params, deps);
  });

  startSyncLoop(DB, { fetchForAddress, enrichWithMonitoring, extractMonitoringConfigs });

  const stocks = Object.values(TOKEN_DATAPOINTS)
    .filter((t) => t.stockSymbol)
    .map((t) => ({ symbol: t.stockSymbol, ticker: t.ticker }));
  if (stocks.length) startEarningsLoop(stocks, DB);

  startPointsLoop(DB);

  const dividendContracts = Object.values(TOKEN_DATAPOINTS)
    .filter((t) => t.dividendContract)
    .map((t) => ({ address: t.dividendContract, ticker: t.ticker }));
  if (dividendContracts.length) startDividendMonitor(dividendContracts, DB);

  // Start Tesla IR disclosure monitoring (daily)
  startDisclosureLoop(DB);
});
