/**
 * Auto-trading strategy templates and execution engine for RWAct.
 * Defines strategy configs (autosell-dividends, CEO departure sell, rebalance on gain),
 * creates corresponding Otomato workflows, and executes trades via CoW Swap when triggered.
 */
const {
  TRIGGERS, ACTIONS,
  Trigger, Action, Workflow, Edge,
  apiServices, ConditionGroup, LOGIC_OPERATORS,
} = require("otomato-sdk");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// --- Strategy Templates ---

const STRATEGY_TEMPLATES = {
  "autosell-dividends": {
    id: "autosell-dividends",
    name: "Auto-sell on dividend",
    description: "Automatically sell your position when a dividend is distributed, converting to USDC.",
    tokenSymbols: ["TSLAx"],
    trigger: "dividend",
    requiresSmartAccount: true,
    params: {},
  },
  "ceo-departure-sell": {
    id: "ceo-departure-sell",
    name: "Sell on CEO departure",
    description: "Sell your entire position if Elon Musk announces he is no longer CEO of Tesla.",
    tokenSymbols: ["TSLAx"],
    trigger: "otomato-workflow",
    requiresSmartAccount: true,
    params: {},
  },
  "rebalance-10pct-gain": {
    id: "rebalance-10pct-gain",
    name: "Rebalance on 10% gain",
    description: "Sell 50% of your position when the price increases by 10% or more in 24 hours, locking in gains.",
    tokenSymbols: ["TSLAx"],
    trigger: "otomato-workflow",
    requiresSmartAccount: true,
    params: { sellPct: 50, gainPct: 10, timePeriod: "24 hours" },
  },
};

/**
 * Return all strategy templates available for a given token symbol.
 * @param {string} tokenSymbol
 * @returns {object[]}
 */
function getTemplatesForToken(tokenSymbol) {
  return Object.values(STRATEGY_TEMPLATES).filter((t) => t.tokenSymbols.includes(tokenSymbol));
}

// --- Otomato workflow creation for strategies ---

/**
 * Create the "CEO departure sell" Otomato workflow.
 * X Trigger → AI Filter → Condition → Webhook to our server
 */
async function createCeoDepartureWorkflow(webhookUrl, expoPushToken) {
  const xTrigger = new Trigger(TRIGGERS.TRENDING.X.X_POST_TRIGGER);
  xTrigger.setParams("username", "elonmusk");
  xTrigger.setParams("includeRetweets", false);

  const aiFilter = new Action(ACTIONS.AI.AI.AI);
  aiFilter.setParams(
    "prompt",
    [
      "Elon Musk is announcing, confirming, or implying that he is stepping down, resigning, being removed, or is no longer the CEO of Tesla.",
      "Only return true if the tweet is a clear, direct statement about leaving the CEO role at Tesla.",
      "Speculation, jokes, sarcasm, or references to other companies (SpaceX, X, xAI) do NOT count.",
    ].join(" ")
  );
  aiFilter.setParams("context", "{{nodeMap.1.output.tweetContent}}");

  const condition = new Action(ACTIONS.CORE.CONDITION.IF);
  condition.setParams("logic", LOGIC_OPERATORS.OR);
  const group = new ConditionGroup(LOGIC_OPERATORS.OR);
  group.addConditionCheck("{{nodeMap.2.output.result}}", "eq", "true");
  condition.setParams("groups", [group]);

  // Webhook back to our server with tweet data
  const webhookAction = new Action(ACTIONS.CORE.HTTP_REQUEST.HTTP_REQUEST);
  webhookAction.setParams("url", webhookUrl);
  webhookAction.setParams("method", "POST");
  webhookAction.setParams("headers", JSON.stringify({ "Content-Type": "application/json" }));
  webhookAction.setParams("body", JSON.stringify({
    strategyId: "ceo-departure-sell",
    tokenSymbol: "TSLAx",
    tweetContent: "{{nodeMap.1.output.tweetContent}}",
    tweetURL: "{{nodeMap.1.output.tweetURL}}",
    account: "{{nodeMap.1.output.account}}",
    timestamp: "{{nodeMap.1.output.timestamp}}",
    aiResult: "{{nodeMap.2.output.result}}",
  }));

  const workflow = new Workflow("Strategy: CEO Departure Sell (TSLAx)");
  workflow.addNodes([xTrigger, aiFilter, condition, webhookAction]);
  workflow.addEdge(new Edge({ source: xTrigger, target: aiFilter }));
  workflow.addEdge(new Edge({ source: aiFilter, target: condition }));
  workflow.addEdge(new Edge({ source: condition, target: webhookAction, label: "true", value: "true" }));

  const result = await workflow.create();
  if (!result.success) throw new Error(`Failed to create CEO departure workflow: ${result.error}`);

  const runResult = await workflow.run();
  if (!runResult.success) throw new Error(`Failed to run CEO departure workflow: ${runResult.error}`);

  return workflow;
}

/**
 * Create the "rebalance on 10% gain" Otomato workflow.
 * Price Trigger (>10% in 24h) → Webhook to our server
 */
async function createRebalanceWorkflow(webhookUrl, tokenAddress, chainId) {
  const priceTrigger = new Trigger(TRIGGERS.TOKENS.PRICE.PRICE_PERCENTAGE_CHANGE);
  priceTrigger.setChainId(chainId);
  priceTrigger.setContractAddress(tokenAddress);
  priceTrigger.setParams("percentageChange", 10);
  priceTrigger.setParams("timePeriod", "24 hours");
  priceTrigger.setParams("currency", "USD");

  const webhookAction = new Action(ACTIONS.CORE.HTTP_REQUEST.HTTP_REQUEST);
  webhookAction.setParams("url", webhookUrl);
  webhookAction.setParams("method", "POST");
  webhookAction.setParams("headers", JSON.stringify({ "Content-Type": "application/json" }));
  webhookAction.setParams("body", JSON.stringify({
    strategyId: "rebalance-10pct-gain",
    tokenSymbol: "TSLAx",
    percentageChange: "{{nodeMap.1.output.percentageChange}}",
    price: "{{nodeMap.1.output.price}}",
  }));

  const workflow = new Workflow("Strategy: Rebalance on 10% Gain (TSLAx)");
  workflow.addNodes([priceTrigger, webhookAction]);
  workflow.addEdge(new Edge({ source: priceTrigger, target: webhookAction }));

  const result = await workflow.create();
  if (!result.success) throw new Error(`Failed to create rebalance workflow: ${result.error}`);

  const runResult = await workflow.run();
  if (!runResult.success) throw new Error(`Failed to run rebalance workflow: ${runResult.error}`);

  return workflow;
}

// --- Strategy execution ---

const TOKEN_ADDRESSES = {
  TSLAx: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
  USDC: "0x2D270e6886d130D724215A266106e6832161EAEd",
};

// Set by init — provides swap execution capability
let _swapExecutor = null;

/**
 * Inject the swap execution function (CoW Swap). Called at server startup.
 * @param {Function} fn - Async function that executes a token swap
 */
function setSwapExecutor(fn) {
  _swapExecutor = fn;
}

/**
 * Execute a token swap on behalf of a user via their smart account.
 * @param {object} DB - Database module
 * @param {string} userId
 * @param {object} opts - Swap parameters (sellToken, buyToken, sellAmount, reason)
 * @returns {Promise<object|null>} Swap result or null on failure
 */
async function executeSwapForUser(DB, userId, { sellToken, buyToken, sellAmount, reason }) {
  const account = DB.getSmartAccountForUser(userId);
  if (!account) {
    console.error(`[strategies] No smart account for user ${userId}, skipping swap`);
    return null;
  }

  if (!_swapExecutor) {
    console.error(`[strategies] No swap executor configured, skipping swap`);
    return null;
  }

  try {
    const result = await _swapExecutor({
      serializedSessionKey: account.serializedSessionKey,
      sessionPrivateKey: account.sessionPrivateKey,
      smartAccountAddress: account.smartAccountAddress,
      sellToken,
      buyToken,
      sellAmount,
      slippageBps: 100, // 1% slippage for automated trades
      validForSecs: 3600,
    });

    console.log(`[strategies] Swap executed for user ${userId}: ${reason}`, result.orderUid || "");
    return result;
  } catch (err) {
    console.error(`[strategies] Swap failed for user ${userId}:`, err.message);
    return null;
  }
}

/** Send an Expo push notification for a strategy execution event. */
async function sendStrategyPush(expoPushToken, { title, body, data }) {
  if (!expoPushToken) return;
  await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: expoPushToken, title: title || "RWAct", body, data }),
  });
}

/**
 * Handle a strategy webhook call from Otomato.
 * Finds all users with the strategy enabled and executes the trade.
 */
async function handleStrategyWebhook(DB, { strategyId, tokenSymbol, ...eventData }) {
  const enabledUsers = DB.getEnabledStrategies(strategyId, tokenSymbol);
  console.log(`[strategies] Webhook received: ${strategyId}/${tokenSymbol} — ${enabledUsers.length} user(s) subscribed`);

  const results = [];

  for (const userStrategy of enabledUsers) {
    const user = DB.getUserById(userStrategy.userId);
    if (!user) continue;

    let swapResult = null;

    if (strategyId === "ceo-departure-sell") {
      // Sell all TSLAx for USDC
      // For demo: sell a fixed amount (10 TSLAx = 10e18 in raw)
      swapResult = await executeSwapForUser(DB, user.id, {
        sellToken: TOKEN_ADDRESSES.TSLAx,
        buyToken: TOKEN_ADDRESSES.USDC,
        sellAmount: "10000000000000000000", // 10 TSLAx (18 decimals)
        reason: `CEO departure detected: ${eventData.tweetContent?.slice(0, 80)}`,
      });

      await sendStrategyPush(user.expoPushToken, {
        body: `Strategy executed: Sold TSLAx — CEO departure detected`,
        data: {
          type: "strategy_executed",
          data: {
            strategyId,
            tokenSymbol,
            action: "sell",
            reason: "CEO departure",
            // Social context (same fields as news notifications)
            source: "twitter",
            entity: "Tesla",
            authorName: "Elon Musk",
            authorHandle: `@${eventData.account || "elonmusk"}`,
            authorAvatar: "https://pbs.twimg.com/profile_images/1590968738358079488/IY9Gx6Ok_400x400.jpg",
            content: eventData.tweetContent,
            url: eventData.tweetURL,
            timestamp: eventData.timestamp,
          },
        },
      });
    }

    if (strategyId === "rebalance-10pct-gain") {
      // Sell 50% — for demo: sell 5 TSLAx
      swapResult = await executeSwapForUser(DB, user.id, {
        sellToken: TOKEN_ADDRESSES.TSLAx,
        buyToken: TOKEN_ADDRESSES.USDC,
        sellAmount: "5000000000000000000", // 5 TSLAx (18 decimals)
        reason: `Rebalance: price +${eventData.percentageChange}% in 24h`,
      });

      await sendStrategyPush(user.expoPushToken, {
        body: `Strategy executed: Sold 50% TSLAx — price up ${eventData.percentageChange}%`,
        data: {
          type: "strategy_executed",
          data: {
            strategyId,
            tokenSymbol,
            action: "partial_sell",
            reason: "rebalance",
            percentageChange: eventData.percentageChange,
            price: eventData.price,
          },
        },
      });
    }

    results.push({ userId: user.id, executed: !!swapResult });
  }

  return results;
}

/**
 * Handle dividend event for autosell strategy.
 * Called from dividends.js when MultiplierUpdated fires.
 */
async function handleDividendStrategy(DB, { ticker, dividendPerShare, dividendPct, transactionHash }) {
  const enabledUsers = DB.getEnabledStrategies("autosell-dividends", ticker);
  if (enabledUsers.length === 0) return;

  console.log(`[strategies] Dividend detected for ${ticker} — executing autosell for ${enabledUsers.length} user(s)`);

  for (const userStrategy of enabledUsers) {
    const user = DB.getUserById(userStrategy.userId);
    if (!user) continue;

    const swapResult = await executeSwapForUser(DB, user.id, {
      sellToken: TOKEN_ADDRESSES[ticker] || TOKEN_ADDRESSES.TSLAx,
      buyToken: TOKEN_ADDRESSES.USDC,
      sellAmount: "10000000000000000000", // 10 TSLAx for demo
      reason: `Autosell dividend: ${dividendPct}% yield`,
    });

    await sendStrategyPush(user.expoPushToken, {
      body: `Strategy executed: Sold TSLAx — dividend ${dividendPct}% detected`,
      data: {
        type: "strategy_executed",
        data: {
          strategyId: "autosell-dividends",
          tokenSymbol: ticker,
          action: "sell",
          reason: "dividend",
          dividendPerShare,
          dividendPct,
          transactionHash,
        },
      },
    });
  }
}

module.exports = {
  STRATEGY_TEMPLATES,
  getTemplatesForToken,
  createCeoDepartureWorkflow,
  createRebalanceWorkflow,
  handleStrategyWebhook,
  handleDividendStrategy,
  setSwapExecutor,
};
