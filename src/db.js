/**
 * SQLite persistence layer for RWAct.
 * Manages users, wallet addresses, Otomato workflows, auto-trading strategies, and ERC-4337 smart accounts.
 */
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "data.db"));

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    authToken TEXT UNIQUE NOT NULL,
    expoPushToken TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL REFERENCES users(id),
    address TEXT NOT NULL,
    UNIQUE(userId, address)
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL REFERENCES users(id),
    workflowId TEXT NOT NULL,
    workflowName TEXT NOT NULL,
    datapointId TEXT NOT NULL,
    tokenSymbol TEXT NOT NULL,
    state TEXT DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS user_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL REFERENCES users(id),
    strategyId TEXT NOT NULL,
    tokenSymbol TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    params TEXT DEFAULT '{}',
    workflowId TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    UNIQUE(userId, strategyId, tokenSymbol)
  );

  CREATE TABLE IF NOT EXISTS smart_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL REFERENCES users(id),
    smartAccountAddress TEXT NOT NULL,
    ownerPrivateKey TEXT NOT NULL,
    sessionPrivateKey TEXT NOT NULL,
    serializedSessionKey TEXT NOT NULL,
    chainId INTEGER DEFAULT 57073,
    createdAt TEXT DEFAULT (datetime('now')),
    UNIQUE(userId, smartAccountAddress)
  );
`);

// --- Users ---

const stmts = {
  insertUser: db.prepare("INSERT INTO users (id, authToken, expoPushToken) VALUES (?, ?, ?)"),
  getUserByToken: db.prepare("SELECT * FROM users WHERE authToken = ?"),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  getAllUsers: db.prepare("SELECT * FROM users"),

  // Addresses
  insertAddress: db.prepare("INSERT OR IGNORE INTO addresses (userId, address) VALUES (?, ?)"),
  getAddresses: db.prepare("SELECT address FROM addresses WHERE userId = ?"),
  removeAddress: db.prepare("DELETE FROM addresses WHERE userId = ? AND address = ?"),
  hasAddress: db.prepare("SELECT 1 FROM addresses WHERE userId = ? AND address = ?"),

  // Workflows
  insertWorkflow: db.prepare("INSERT INTO workflows (userId, workflowId, workflowName, datapointId, tokenSymbol, state) VALUES (?, ?, ?, ?, ?, ?)"),
  getWorkflows: db.prepare("SELECT * FROM workflows WHERE userId = ?"),
  getWorkflowsBySymbol: db.prepare("SELECT * FROM workflows WHERE userId = ? AND tokenSymbol = ? AND state != 'stopped'"),
  getAllWorkflowSymbols: db.prepare("SELECT DISTINCT tokenSymbol FROM workflows WHERE userId = ? AND state != 'stopped'"),
  updateWorkflowState: db.prepare("UPDATE workflows SET state = ? WHERE workflowId = ?"),
  getActiveWorkflowsBySymbol: db.prepare("SELECT * FROM workflows WHERE userId = ? AND tokenSymbol = ? AND state = 'active'"),
  getStoppedWorkflowsBySymbol: db.prepare("SELECT * FROM workflows WHERE userId = ? AND tokenSymbol = ? AND state = 'stopped'"),

  // Strategies
  upsertStrategy: db.prepare("INSERT INTO user_strategies (userId, strategyId, tokenSymbol, enabled, params, workflowId) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(userId, strategyId, tokenSymbol) DO UPDATE SET enabled=1, params=excluded.params, workflowId=excluded.workflowId"),
  disableStrategy: db.prepare("UPDATE user_strategies SET enabled = 0 WHERE userId = ? AND strategyId = ? AND tokenSymbol = ?"),
  getStrategy: db.prepare("SELECT * FROM user_strategies WHERE userId = ? AND strategyId = ? AND tokenSymbol = ?"),
  getStrategiesForUser: db.prepare("SELECT * FROM user_strategies WHERE userId = ?"),
  getEnabledStrategies: db.prepare("SELECT * FROM user_strategies WHERE strategyId = ? AND tokenSymbol = ? AND enabled = 1"),
  getEnabledStrategiesForUser: db.prepare("SELECT * FROM user_strategies WHERE userId = ? AND enabled = 1"),
  getAllEnabledStrategies: db.prepare("SELECT us.*, u.expoPushToken FROM user_strategies us JOIN users u ON u.id = us.userId WHERE us.enabled = 1"),

  // Smart accounts
  insertSmartAccount: db.prepare("INSERT INTO smart_accounts (userId, smartAccountAddress, ownerPrivateKey, sessionPrivateKey, serializedSessionKey, chainId) VALUES (?, ?, ?, ?, ?, ?)"),
  getSmartAccounts: db.prepare("SELECT * FROM smart_accounts WHERE userId = ?"),
  getSmartAccountByAddress: db.prepare("SELECT * FROM smart_accounts WHERE smartAccountAddress = ?"),
  getSmartAccountForUser: db.prepare("SELECT * FROM smart_accounts WHERE userId = ? LIMIT 1"),
};

/**
 * Create a new user with an auth token and Expo push token.
 * @param {string} id
 * @param {string} authToken
 * @param {string} expoPushToken
 */
function createUser(id, authToken, expoPushToken) {
  stmts.insertUser.run(id, authToken, expoPushToken);
}

/** @param {string} authToken @returns {object|undefined} */
function getUserByToken(authToken) {
  return stmts.getUserByToken.get(authToken);
}

/** @param {string} id @returns {object|undefined} */
function getUserById(id) {
  return stmts.getUserById.get(id);
}

/** @returns {object[]} All registered users. */
function getAllUsers() {
  return stmts.getAllUsers.all();
}

/**
 * Associate a wallet address with a user (idempotent).
 * @param {string} userId
 * @param {string} address - EVM wallet address
 */
function addAddress(userId, address) {
  stmts.insertAddress.run(userId, address);
}

/**
 * @param {string} userId
 * @returns {string[]} List of wallet addresses for the user.
 */
function getAddresses(userId) {
  return stmts.getAddresses.all(userId).map((r) => r.address);
}

/**
 * Remove a wallet address from a user.
 * @param {string} userId
 * @param {string} address
 * @returns {boolean} True if the address was found and removed.
 */
function removeAddress(userId, address) {
  const result = stmts.removeAddress.run(userId, address);
  return result.changes > 0;
}

/** @returns {boolean} Whether the user has this address registered. */
function hasAddress(userId, address) {
  return !!stmts.hasAddress.get(userId, address);
}

/**
 * Persist an Otomato workflow record for a user.
 * @param {string} userId
 * @param {object} wf - Workflow metadata (workflowId, workflowName, datapointId, tokenSymbol, state)
 */
function addWorkflow(userId, { workflowId, workflowName, datapointId, tokenSymbol, state }) {
  stmts.insertWorkflow.run(userId, workflowId, workflowName, datapointId, tokenSymbol, state || "active");
}

/** @returns {object[]} All workflow records for the user. */
function getWorkflows(userId) {
  return stmts.getWorkflows.all(userId);
}

/** @returns {string[]} Distinct token symbols with active workflows for the user. */
function getWorkflowSymbols(userId) {
  return stmts.getAllWorkflowSymbols.all(userId).map((r) => r.tokenSymbol);
}

/** @returns {object[]} Active workflows for a specific token symbol. */
function getActiveWorkflowsBySymbol(userId, tokenSymbol) {
  return stmts.getActiveWorkflowsBySymbol.all(userId, tokenSymbol);
}

/** @returns {object[]} Stopped workflows for a specific token symbol. */
function getStoppedWorkflowsBySymbol(userId, tokenSymbol) {
  return stmts.getStoppedWorkflowsBySymbol.all(userId, tokenSymbol);
}

/** Update a workflow's state (e.g. "active", "stopped"). */
function updateWorkflowState(workflowId, state) {
  stmts.updateWorkflowState.run(state, workflowId);
}

/**
 * Enable (or re-enable) an auto-trading strategy for a user/token pair.
 * @param {string} userId
 * @param {string} strategyId
 * @param {string} tokenSymbol
 * @param {object} params - Strategy-specific parameters
 * @param {string|null} workflowId - Associated Otomato workflow ID
 */
function enableStrategy(userId, strategyId, tokenSymbol, params, workflowId) {
  stmts.upsertStrategy.run(userId, strategyId, tokenSymbol, JSON.stringify(params || {}), workflowId || null);
}

/** Disable a strategy for a user/token pair. */
function disableStrategy(userId, strategyId, tokenSymbol) {
  stmts.disableStrategy.run(userId, strategyId, tokenSymbol);
}

/** @returns {object|undefined} Strategy record with parsed params. */
function getStrategy(userId, strategyId, tokenSymbol) {
  const s = stmts.getStrategy.get(userId, strategyId, tokenSymbol);
  if (s) s.params = JSON.parse(s.params || "{}");
  return s;
}

/** @returns {object[]} All strategies (enabled and disabled) for a user. */
function getStrategiesForUser(userId) {
  return stmts.getStrategiesForUser.all(userId).map((s) => ({ ...s, params: JSON.parse(s.params || "{}") }));
}

/** @returns {object[]} All users who have this strategy enabled for this token. */
function getEnabledStrategies(strategyId, tokenSymbol) {
  return stmts.getEnabledStrategies.all(strategyId, tokenSymbol).map((s) => ({ ...s, params: JSON.parse(s.params || "{}") }));
}

/** @returns {object[]} All enabled strategies for a specific user. */
function getEnabledStrategiesForUser(userId) {
  return stmts.getEnabledStrategiesForUser.all(userId).map((s) => ({ ...s, params: JSON.parse(s.params || "{}") }));
}

/** @returns {object[]} All enabled strategies across all users, joined with push tokens. */
function getAllEnabledStrategies() {
  return stmts.getAllEnabledStrategies.all().map((s) => ({ ...s, params: JSON.parse(s.params || "{}") }));
}

/**
 * Store ERC-4337 smart account credentials for a user.
 * @param {string} userId
 * @param {object} account - Smart account details (address, keys, serialized session)
 */
function addSmartAccount(userId, { smartAccountAddress, ownerPrivateKey, sessionPrivateKey, serializedSessionKey, chainId }) {
  stmts.insertSmartAccount.run(userId, smartAccountAddress, ownerPrivateKey, sessionPrivateKey, serializedSessionKey, chainId || 57073);
}

/** @returns {object[]} All smart accounts for a user. */
function getSmartAccounts(userId) {
  return stmts.getSmartAccounts.all(userId);
}

/** @returns {object|undefined} Smart account record by on-chain address. */
function getSmartAccountByAddress(address) {
  return stmts.getSmartAccountByAddress.get(address);
}

/** @returns {object|undefined} The first smart account for a user. */
function getSmartAccountForUser(userId) {
  return stmts.getSmartAccountForUser.get(userId);
}

module.exports = {
  db,
  createUser, getUserByToken, getUserById, getAllUsers,
  addAddress, getAddresses, removeAddress, hasAddress,
  addWorkflow, getWorkflows, getWorkflowSymbols,
  getActiveWorkflowsBySymbol, getStoppedWorkflowsBySymbol, updateWorkflowState,
  addSmartAccount, getSmartAccounts, getSmartAccountByAddress, getSmartAccountForUser,
  enableStrategy, disableStrategy, getStrategy, getStrategiesForUser,
  getEnabledStrategies, getEnabledStrategiesForUser, getAllEnabledStrategies,
};
