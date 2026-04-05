/**
 * SEC EDGAR filing monitor for RWAct.
 * Polls Tesla's SEC filings daily, detects new material filings (10-K, 10-Q, 8-K, etc.),
 * and sends push notifications to all registered users.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// Tesla CIK on SEC EDGAR
const TESLA_CIK = "0001318605";
const EDGAR_URL = `https://data.sec.gov/submissions/CIK${TESLA_CIK}.json`;
const EDGAR_HEADERS = { "User-Agent": "Otomato contact@otomato.xyz", Accept: "application/json" };

// Only track material filings
const TRACKED_FORMS = new Set(["10-K", "10-Q", "8-K", "DEFA14A", "DEF 14A", "S-1", "S-3"]);

// In-memory: set of known filing accession numbers
const knownFilings = new Set();
let firstRun = true;
let _DB = null;

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
    console.log(`[disclosures] Push sent: ${body}`, result.data?.status || "");
  }
}

/**
 * Fetch recent Tesla filings from SEC EDGAR and filter to material form types.
 * @returns {Promise<{ form: string, date: string, description: string, accession: string, url: string }[]>}
 */
async function fetchFilings() {
  const res = await fetch(EDGAR_URL, { headers: EDGAR_HEADERS });
  if (!res.ok) throw new Error(`EDGAR API returned ${res.status}`);
  const data = await res.json();
  const r = data.filings.recent;

  return r.form.map((form, i) => ({
    form,
    date: r.filingDate[i],
    description: r.primaryDocDescription[i] || form,
    accession: r.accessionNumber[i],
    primaryDoc: r.primaryDocument[i],
    url: `https://www.sec.gov/Archives/edgar/data/${TESLA_CIK.replace(/^0+/, "")}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`,
  })).filter((f) => TRACKED_FORMS.has(f.form));
}

/** Check for new SEC filings and notify users. Skips notifications on first run (baseline load). */
async function checkDisclosures() {
  console.log("[disclosures] Checking SEC EDGAR for new Tesla filings...");

  let filings;
  try {
    filings = await fetchFilings();
  } catch (err) {
    console.error("[disclosures] Fetch failed:", err.message);
    return;
  }

  console.log(`[disclosures] Found ${filings.length} tracked filings`);

  for (const filing of filings) {
    if (knownFilings.has(filing.accession)) continue;
    knownFilings.add(filing.accession);

    if (firstRun) continue;

    console.log(`[disclosures] New filing: ${filing.form} - ${filing.description} (${filing.date})`);
    await sendPushToAll({
      title: "RWAct",
      body: `Tesla ${filing.form} filed: ${filing.description}`,
      data: {
        type: "disclosure",
        data: {
          ticker: "TSLAx",
          source: "sec_edgar",
          form: filing.form,
          date: filing.date,
          description: filing.description,
          url: filing.url,
        },
      },
    });
  }

  if (firstRun) {
    console.log(`[disclosures] Baseline loaded: ${knownFilings.size} filings`);
    firstRun = false;
  }
}

/**
 * Start the daily SEC EDGAR disclosure monitoring loop.
 * @param {object} DB - Database module (used for resolving push tokens)
 * @returns {NodeJS.Timeout}
 */
function startDisclosureLoop(DB) {
  _DB = DB;
  checkDisclosures();
  const intervalId = setInterval(checkDisclosures, CHECK_INTERVAL_MS);
  console.log(`[disclosures] Monitoring loop started (every 24h)`);
  return intervalId;
}

module.exports = { startDisclosureLoop, checkDisclosures, fetchFilings };
