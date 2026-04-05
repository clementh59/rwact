/**
 * Otomato SDK workflow factories for RWAct.
 * Creates and deploys notification workflows: X post monitoring, price movement alerts,
 * and smart account transaction triggers — all routing to Expo push notifications.
 */
const {
  TRIGGERS, ACTIONS,
  Trigger, Action, Workflow, Edge,
  apiServices,
  ConditionGroup, LOGIC_OPERATORS,
} = require("otomato-sdk");

const OTOMATO_AUTH = process.env.OTOMATO_AUTH;
if (!OTOMATO_AUTH) {
  throw new Error("OTOMATO_AUTH is required in .env");
}
apiServices.setAuth(OTOMATO_AUTH);

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Build a JSON body string for the Expo push API, embedding Otomato template variables.
 * @param {object} opts
 * @param {string} opts.expoPushToken
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {object} opts.data
 * @returns {string} Stringified push payload
 */
function expoPushBody({ expoPushToken, title, body, data }) {
  return JSON.stringify({
    to: expoPushToken,
    title,
    body,
    data,
  });
}

/**
 * Create an Otomato HTTP_REQUEST action node that POSTs to Expo Push.
 * @param {string} bodyStr - JSON string payload
 * @returns {Action}
 */
function createPushAction(bodyStr) {
  const pushAction = new Action(ACTIONS.CORE.HTTP_REQUEST.HTTP_REQUEST);
  pushAction.setParams("url", EXPO_PUSH_URL);
  pushAction.setParams("method", "POST");
  pushAction.setParams("headers", JSON.stringify({ "Content-Type": "application/json" }));
  pushAction.setParams("body", bodyStr);
  return pushAction;
}

/**
 * Create an X Post monitoring workflow: X trigger -> AI materiality filter -> AI summary -> Expo push.
 * @param {object} opts
 * @param {string} opts.username - X/Twitter handle to monitor
 * @param {string} opts.tokenName - Token ticker for context (e.g. "TSLAx")
 * @param {string} opts.entity - Human-readable entity name (e.g. "Tesla")
 * @param {string} [opts.authorAvatar] - Avatar URL for the push notification payload
 * @param {string} opts.expoPushToken - Recipient push token
 * @returns {Promise<Workflow>} The created and running workflow
 */
async function createXMonitorWorkflow({ username, tokenName, entity, authorAvatar, expoPushToken }) {
  // 1. Trigger: X post
  const xTrigger = new Trigger(TRIGGERS.TRENDING.X.X_POST_TRIGGER);
  xTrigger.setParams("username", username);
  xTrigger.setParams("includeRetweets", false);

  // 2. Action: AI filter (boolean) — decides forward or reject
  const aiFilter = new Action(ACTIONS.AI.AI.AI);
  aiFilter.setParams(
    "prompt",
    [
      `This tweet could materially impact ${entity || tokenName}'s stock price.`,
      `Material = earnings, revenue, production numbers, regulatory, product launches, executive changes, lawsuits, M&A, guidance, partnerships, recalls, investigations.`,
      `NOT material = personal opinions, memes, jokes, replies, crypto/DOGE, political commentary, SpaceX/Boring Company (unless directly affecting ${entity || tokenName}).`,
    ].join(" ")
  );
  aiFilter.setParams("context", "{{nodeMap.1.output.tweetContent}}");

  // 3. Condition: only forward if AI returned "true"
  const condition = new Action(ACTIONS.CORE.CONDITION.IF);
  condition.setParams("logic", LOGIC_OPERATORS.OR);
  const group = new ConditionGroup(LOGIC_OPERATORS.OR);
  group.addConditionCheck("{{nodeMap.2.output.result}}", "eq", "true");
  condition.setParams("groups", [group]);

  // 4. Action: AI summary — generates the notification text (only reached if forwarded)
  const aiSummary = new Action(ACTIONS.AI.AI.AI_TEXT);
  aiSummary.setParams(
    "prompt",
    `Summarize this tweet in one sentence for ${tokenName} holders. Focus on what it means for the stock price. Be concise and factual.`
  );
  aiSummary.setParams("context", "{{nodeMap.1.output.tweetContent}}");

  // 5. Action: Expo push notification
  const pushAction = createPushAction(expoPushBody({
    expoPushToken,
    title: "RWAct",
    body: `{{nodeMap.4.output.result}}`,
    data: {
      type: "news",
      data: {
        ticker: tokenName,
        source: "twitter",
        entity: entity || tokenName,
        summary: "{{nodeMap.4.output.result}}",
        authorName: entity || username,
        authorHandle: `@${username}`,
        authorAvatar: authorAvatar || "",
        content: "{{nodeMap.1.output.tweetContent}}",
        url: "{{nodeMap.1.output.tweetURL}}",
      },
    },
  }));

  // Build workflow: trigger → AI filter → condition → AI summary → push
  const workflow = new Workflow(`X Monitor: @${username} (${tokenName})`);
  workflow.addNodes([xTrigger, aiFilter, condition, aiSummary, pushAction]);
  workflow.addEdge(new Edge({ source: xTrigger, target: aiFilter }));
  workflow.addEdge(new Edge({ source: aiFilter, target: condition }));
  workflow.addEdge(new Edge({ source: condition, target: aiSummary, label: "true", value: "true" }));
  workflow.addEdge(new Edge({ source: aiSummary, target: pushAction }));

  const result = await workflow.create();
  if (!result.success) throw new Error(`Failed to create X workflow: ${result.error}`);

  const runResult = await workflow.run();
  if (!runResult.success) throw new Error(`Failed to run X workflow: ${runResult.error}`);

  return workflow;
}

/**
 * Create a price movement alert workflow: price trigger -> Expo push.
 * @param {object} opts
 * @param {string} opts.tokenName - Token ticker
 * @param {string} opts.contractAddress - Token contract address
 * @param {number} opts.chainId
 * @param {number} opts.percentageChange - Threshold percentage
 * @param {string} opts.timePeriod - Time window (e.g. "4 hours")
 * @param {string} opts.expoPushToken
 * @returns {Promise<Workflow>}
 */
async function createPriceMovementWorkflow({ tokenName, contractAddress, chainId, percentageChange, timePeriod, expoPushToken }) {
  // 1. Trigger: price percentage change
  const priceTrigger = new Trigger(TRIGGERS.TOKENS.PRICE.PRICE_PERCENTAGE_CHANGE);
  priceTrigger.setChainId(chainId);
  priceTrigger.setContractAddress(contractAddress);
  priceTrigger.setParams("percentageChange", percentageChange);
  priceTrigger.setParams("timePeriod", timePeriod);
  priceTrigger.setParams("currency", "USD");

  // 2. Action: Expo push notification
  const pushAction = createPushAction(expoPushBody({
    expoPushToken,
    title: "RWAct",
    body: `${tokenName} moved {{nodeMap.1.output.percentageChange}}% in ${timePeriod}`,
    data: {
      type: "price_movement",
      data: {
        ticker: tokenName,
        percentageChange: "{{nodeMap.1.output.percentageChange}}",
        price: "{{nodeMap.1.output.price}}",
        currency: "{{nodeMap.1.output.currency}}",
        timePeriod,
      },
    },
  }));

  const workflow = new Workflow(`Price Alert: ${tokenName} >${percentageChange}% in ${timePeriod}`, [priceTrigger, pushAction]);
  workflow.addEdge(new Edge({ source: priceTrigger, target: pushAction }));

  const result = await workflow.create();
  if (!result.success) throw new Error(`Failed to create price workflow: ${result.error}`);

  const runResult = await workflow.run();
  if (!runResult.success) throw new Error(`Failed to run price workflow: ${runResult.error}`);

  return workflow;
}

/**
 * Create all notification workflows for a detected token based on its datapoint config.
 * Iterates over news items and price thresholds, creating one workflow per datapoint.
 * @param {object} monitoring - Token monitoring config (from datapoints.js)
 * @param {string} expoPushToken
 * @returns {Promise<{ datapointId: string, workflowId: string, workflowName: string }[]>}
 */
async function createWorkflowsForToken(monitoring, expoPushToken) {
  const created = [];

  for (const dp of monitoring.datapoints) {
    // X monitoring (major_news → items with source=twitter)
    if (dp.id === "major_news" && dp.items) {
      for (const item of dp.items) {
        if (item.source === "twitter" && item.handle) {
          const wf = await createXMonitorWorkflow({
            username: item.handle,
            tokenName: monitoring.ticker,
            entity: item.entity,
            authorAvatar: item.avatarUrl,
            expoPushToken,
          });
          created.push({ datapointId: `${dp.id}.${item.id}`, workflowId: wf.id, workflowName: wf.name });
        }
      }
    }

    // Price movement
    if (dp.id === "price_movement" && dp.thresholds) {
      for (const th of dp.thresholds) {
        const addr = monitoring.addresses?.[0];
        if (!addr) continue;

        const wf = await createPriceMovementWorkflow({
          tokenName: monitoring.ticker,
          contractAddress: addr.address,
          chainId: addr.chainId || 1,
          percentageChange: th.pct,
          timePeriod: th.window === "4h" ? "4 hours" : th.window === "24h" ? "24 hours" : th.window,
          expoPushToken,
        });
        created.push({ datapointId: `${dp.id}.${th.pct}pct_${th.window}`, workflowId: wf.id, workflowName: wf.name });
      }
    }
  }

  return created;
}

/**
 * Create a workflow that triggers a smart account transaction via HTTP.
 *
 * Trigger: price percentage change on a token
 * Action: POST to our API /smart-account/execute
 *
 * @param {object} opts
 * @param {string} opts.apiBaseUrl - e.g. "https://your-server.com" or "http://localhost:3000"
 * @param {string} opts.authToken - Bearer token for the user
 * @param {string} opts.tokenName - e.g. "TSLAx"
 * @param {string} opts.contractAddress - token contract
 * @param {number} opts.chainId - trigger chain id
 * @param {number} opts.percentageChange - trigger threshold
 * @param {string} opts.timePeriod - e.g. "4 hours"
 * @param {object} opts.tx - { to, value, data } — the transaction to execute
 * @param {string} [opts.expoPushToken] - optional push notification after execution
 */
async function createSmartAccountWorkflow({
  apiBaseUrl, authToken, tokenName, contractAddress, chainId,
  percentageChange, timePeriod, tx, expoPushToken,
}) {
  // 1. Trigger: price percentage change
  const priceTrigger = new Trigger(TRIGGERS.TOKENS.PRICE.PRICE_PERCENTAGE_CHANGE);
  priceTrigger.setChainId(chainId);
  priceTrigger.setContractAddress(contractAddress);
  priceTrigger.setParams("percentageChange", percentageChange);
  priceTrigger.setParams("timePeriod", timePeriod);
  priceTrigger.setParams("currency", "USD");

  // 2. Action: POST to smart-account/execute
  const executeAction = new Action(ACTIONS.CORE.HTTP_REQUEST.HTTP_REQUEST);
  executeAction.setParams("url", `${apiBaseUrl}/smart-account/execute`);
  executeAction.setParams("method", "POST");
  executeAction.setParams("headers", JSON.stringify({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
  }));
  executeAction.setParams("body", JSON.stringify({
    to: tx.to,
    value: tx.value || "0",
    data: tx.data || "0x",
  }));

  const nodes = [priceTrigger, executeAction];
  const edges = [new Edge({ source: priceTrigger, target: executeAction })];

  // 3. Optional: push notification after execution
  if (expoPushToken) {
    const pushAction = createPushAction(expoPushBody({
      expoPushToken,
      title: "RWAct",
      body: `Smart account tx executed: ${tokenName} moved {{nodeMap.1.output.percentageChange}}%`,
      data: {
        type: "smart_account_tx",
        data: {
          ticker: tokenName,
          percentageChange: "{{nodeMap.1.output.percentageChange}}",
          txResult: "{{nodeMap.2.output.data}}",
        },
      },
    }));
    nodes.push(pushAction);
    edges.push(new Edge({ source: executeAction, target: pushAction }));
  }

  const workflow = new Workflow(`Smart Account: ${tokenName} >${percentageChange}% → Execute`, nodes);
  for (const edge of edges) workflow.addEdge(edge);

  const result = await workflow.create();
  if (!result.success) throw new Error(`Failed to create smart account workflow: ${result.error}`);

  const runResult = await workflow.run();
  if (!runResult.success) throw new Error(`Failed to run smart account workflow: ${runResult.error}`);

  return workflow;
}

module.exports = {
  createXMonitorWorkflow, createPriceMovementWorkflow, createWorkflowsForToken,
  createSmartAccountWorkflow,
};
