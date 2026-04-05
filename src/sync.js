/**
 * Portfolio sync loop for RWAct.
 * Periodically re-fetches each user's on-chain positions, creates workflows for newly detected
 * tokens, stops workflows for removed positions, and restarts workflows for re-detected ones.
 */
const { Workflow } = require("otomato-sdk");
const { createWorkflowsForToken } = require("./workflows");
const { TOKEN_DATAPOINTS } = require("./config/datapoints");

const SYNC_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Start the periodic portfolio sync loop for all registered users.
 * @param {object} DB - Database module
 * @param {object} helpers - DeBank fetch/enrich/extract functions from index.js
 * @returns {NodeJS.Timeout} Interval ID
 */
function startSyncLoop(DB, { fetchForAddress, enrichWithMonitoring, extractMonitoringConfigs }) {
  async function syncAllUsers() {
    const userList = DB.getAllUsers();
    if (userList.length === 0) return;

    console.log(`[sync] Starting portfolio sync for ${userList.length} user(s)...`);

    for (const user of userList) {
      try {
        await syncUser(user, DB, { fetchForAddress, enrichWithMonitoring, extractMonitoringConfigs });
      } catch (err) {
        console.error(`[sync] Error syncing user ${user.id}:`, err.message);
      }
    }

    console.log(`[sync] Portfolio sync complete.`);
  }

  syncAllUsers();
  const intervalId = setInterval(syncAllUsers, SYNC_INTERVAL_MS);
  console.log(`[sync] Portfolio sync loop started (every ${SYNC_INTERVAL_MS / 3600000}h)`);
  return intervalId;
}

/**
 * Sync a single user's portfolio: detect new/removed positions and create/stop/restart workflows accordingly.
 * @param {object} user - User record from DB
 * @param {object} DB
 * @param {object} helpers
 */
async function syncUser(user, DB, { fetchForAddress, enrichWithMonitoring, extractMonitoringConfigs }) {
  const addresses = DB.getAddresses(user.id);
  if (addresses.length === 0) return;

  const allPositions = await Promise.all(addresses.map(fetchForAddress));
  enrichWithMonitoring(allPositions);
  const currentConfigs = extractMonitoringConfigs(allPositions);
  const currentSymbols = new Set(currentConfigs.map((c) => c.symbol));

  const previousSymbols = new Set(DB.getWorkflowSymbols(user.id));

  // New positions → create workflows
  const newSymbols = [...currentSymbols].filter((s) => !previousSymbols.has(s));
  for (const symbol of newSymbols) {
    const monitoring = currentConfigs.find((c) => c.symbol === symbol);
    const fullConfig = TOKEN_DATAPOINTS[symbol];
    if (fullConfig) monitoring.addresses = fullConfig.addresses;

    console.log(`[sync] New position detected for user ${user.id}: ${symbol}`);
    try {
      const created = await createWorkflowsForToken(monitoring, user.expoPushToken);
      for (const wf of created) {
        DB.addWorkflow(user.id, { ...wf, tokenSymbol: symbol, state: "active" });
      }
      console.log(`[sync] Created ${created.length} workflow(s) for ${symbol}`);
    } catch (err) {
      console.error(`[sync] Failed to create workflows for ${symbol}:`, err.message);
    }
  }

  // Removed positions → stop workflows
  const removedSymbols = [...previousSymbols].filter((s) => !currentSymbols.has(s));
  for (const symbol of removedSymbols) {
    const wfs = DB.getActiveWorkflowsBySymbol(user.id, symbol);
    console.log(`[sync] Position removed for user ${user.id}: ${symbol} — stopping ${wfs.length} workflow(s)`);

    for (const wfRecord of wfs) {
      try {
        const wf = new Workflow();
        await wf.load(wfRecord.workflowId);
        await wf.stop();
        DB.updateWorkflowState(wfRecord.workflowId, "stopped");
        console.log(`[sync] Stopped workflow ${wfRecord.workflowId} (${wfRecord.workflowName})`);
      } catch (err) {
        console.error(`[sync] Failed to stop workflow ${wfRecord.workflowId}:`, err.message);
      }
    }
  }

  // Re-detected positions → restart stopped workflows
  for (const symbol of currentSymbols) {
    const stoppedWfs = DB.getStoppedWorkflowsBySymbol(user.id, symbol);
    if (stoppedWfs.length === 0) continue;

    console.log(`[sync] Position re-detected for user ${user.id}: ${symbol} — restarting ${stoppedWfs.length} workflow(s)`);
    for (const wfRecord of stoppedWfs) {
      try {
        const wf = new Workflow();
        await wf.load(wfRecord.workflowId);
        await wf.run();
        DB.updateWorkflowState(wfRecord.workflowId, "active");
        console.log(`[sync] Restarted workflow ${wfRecord.workflowId} (${wfRecord.workflowName})`);
      } catch (err) {
        console.error(`[sync] Failed to restart workflow ${wfRecord.workflowId}:`, err.message);
      }
    }
  }
}

module.exports = { startSyncLoop, syncUser };
