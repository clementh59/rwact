/**
 * Earnings call monitoring for RWAct.
 * Polls Alpha Vantage for upcoming earnings dates and sends push notifications
 * at three stages: detection, one-week reminder, and 24-hour reminder.
 */
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
if (!ALPHA_VANTAGE_KEY) {
  throw new Error("ALPHA_VANTAGE_KEY is required in .env");
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check every 6h
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// In-memory store: symbol → { reportDate, notified: { detected, week, day } }
const earningsState = {};

/** Derive a human-readable quarter label (e.g. "Q1 2026") from a fiscal date ending string. */
function getQuarter(fiscalDateEnding) {
  if (!fiscalDateEnding) return "Q?";
  const d = new Date(fiscalDateEnding + "T00:00:00Z");
  if (isNaN(d.getTime())) return "Q?";
  const q = Math.ceil((d.getUTCMonth() + 1) / 3);
  return `Q${q} ${d.getUTCFullYear()}`;
}

/** Parse a CSV string (from Alpha Vantage) into an array of row objects. */
function parseCSV(csv) {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h.trim()] = values[i]?.trim() || ""));
    return row;
  });
}

/**
 * Fetch the 12-month earnings calendar for a stock symbol from Alpha Vantage.
 * @param {string} symbol - Stock ticker (e.g. "TSLA")
 * @returns {Promise<object[]>}
 */
async function fetchEarnings(symbol) {
  const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${symbol}&horizon=12month&apikey=${ALPHA_VANTAGE_KEY}`;
  const res = await fetch(url);
  const text = await res.text();
  return parseCSV(text);
}

/** Send an Expo push notification to all provided push tokens. */
async function sendPushToAll(pushTokens, { title, body, data }) {
  for (const to of pushTokens) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, title, body, data }),
    });
    const result = await res.json();
    console.log(`[earnings] Push sent: ${body}`, result.data?.status || "");
  }
}

/**
 * Check earnings for a single symbol and send notifications as needed.
 */
async function checkEarningsForSymbol(symbol, ticker, pushTokens) {
  const entries = await fetchEarnings(symbol);
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.reportDate) continue;

    const reportDate = new Date(entry.reportDate + "T00:00:00Z");
    const reportMs = reportDate.getTime();
    const key = `${symbol}:${entry.reportDate}`;
    const timeUntil = reportMs - now;

    // Skip past earnings
    if (timeUntil < -ONE_DAY_MS) continue;

    // Initialize state for this earnings entry
    if (!earningsState[key]) {
      earningsState[key] = { reportDate: entry.reportDate, notified: {} };
    }
    const state = earningsState[key];

    const quarter = getQuarter(entry.fiscalDateEnding);
    const eventTimestamp = Math.floor(reportMs / 1000);
    const estimatedEPS = entry.estimate ? parseFloat(entry.estimate) : null;
    const daysUntil = Math.ceil(timeUntil / ONE_DAY_MS);

    const earningData = {
      token: ticker,
      eventTimestamp,
      quarter,
      estimatedEPS,
    };

    // 1. Announcement: first time we see this entry
    if (!state.notified.detected) {
      state.notified.detected = true;
      await sendPushToAll(pushTokens, {
        title: "RWAct",
        body: `${ticker} ${quarter} earnings call detected (in ${daysUntil} days)`,
        data: { type: "earning_call", data: earningData },
      });
    }

    // 2. One week reminder
    if (!state.notified.week && timeUntil <= ONE_WEEK_MS && timeUntil > ONE_DAY_MS) {
      state.notified.week = true;
      await sendPushToAll(pushTokens, {
        title: "RWAct",
        body: `${ticker} ${quarter} earnings call in ${daysUntil} days`,
        data: { type: "earning_call", data: earningData },
      });
    }

    // 3. 24h reminder
    if (!state.notified.day && timeUntil <= ONE_DAY_MS && timeUntil > 0) {
      state.notified.day = true;
      await sendPushToAll(pushTokens, {
        title: "RWAct",
        body: `${ticker} ${quarter} earnings call tomorrow`,
        data: { type: "earning_call", data: earningData },
      });
    }
  }
}

/**
 * Start the earnings monitoring loop.
 *
 * @param {Array<{symbol: string, ticker: string}>} stocks - e.g. [{ symbol: "TSLA", ticker: "TSLAx" }]
 */
function startEarningsLoop(stocks, DB) {
  function getAllPushTokens() {
    return [...new Set(DB.getAllUsers().map((u) => u.expoPushToken).filter(Boolean))];
  }

  async function check() {
    const pushTokens = getAllPushTokens();
    if (pushTokens.length === 0) return;
    console.log(`[earnings] Checking earnings for ${stocks.length} stock(s), ${pushTokens.length} user(s)...`);
    for (const { symbol, ticker } of stocks) {
      try {
        await checkEarningsForSymbol(symbol, ticker, pushTokens);
      } catch (err) {
        console.error(`[earnings] Error checking ${symbol}:`, err.message);
      }
    }
    console.log(`[earnings] Check complete.`);
  }

  check();
  const intervalId = setInterval(check, CHECK_INTERVAL_MS);
  console.log(`[earnings] Monitoring loop started (every ${CHECK_INTERVAL_MS / 3600000}h)`);
  return intervalId;
}

module.exports = { startEarningsLoop, checkEarningsForSymbol, fetchEarnings, earningsState };
