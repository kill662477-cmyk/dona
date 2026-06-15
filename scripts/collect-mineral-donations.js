const fs = require("fs/promises");
const path = require("path");

const SOURCE_URL = "https://ygosu.com/board/pan_monstarz/?mode=mineral_storage";
const OUTPUT_PATH = path.join(__dirname, "..", "data", "mineral-donations.json");
const MAX_PAGES = Number(process.env.MINERAL_MAX_PAGES || 700);
const REQUEST_DELAY_MS = Number(process.env.MINERAL_REQUEST_DELAY_MS || 120);
const REQUEST_TIMEOUT_MS = Number(process.env.MINERAL_REQUEST_TIMEOUT_MS || 30000);
const STOP_AFTER_DUPLICATE_PAGES = Number(process.env.MINERAL_DUPLICATE_PAGE_STOP || 3);
const SYSTEM_MEMBER_IDS = new Set(["1"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; MonstarzMineralRank/1.0; +https://monstarznew.vercel.app/)",
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function pageUrl(page) {
  return page <= 1 ? SOURCE_URL : `${SOURCE_URL}&page=${page}`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/\s+/g, " ")
    .trim();
}

function parseMineralAmount(value) {
  const text = String(value || "").trim();
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return 0;
  return (text.startsWith("-") ? -1 : 1) * Number(digits);
}

function extractCurrentStorage(html) {
  const history = (html.match(/<div class="mineral_storage_history"[\s\S]*?<\/div>/i) || [
    "",
  ])[0];
  const storageText = decodeHtml(
    (history.match(/<h3[\s\S]*?<strong>([\s\S]*?)<\/strong>/i) || [])[1] || ""
  );

  return {
    text: storageText,
    mineral: parseMineralAmount(storageText),
  };
}

function parseRows(html, page) {
  const scope = (html.match(/<div class="mineral_storage_history"[\s\S]*?<\/table>/i) || [
    html,
  ])[0];

  return [...scope.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((match) => {
      const rowHtml = match[0];
      const cols = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((col) =>
        decodeHtml(col[1])
      );
      const onclick =
        (rowHtml.match(/onclick="([^"]*show_nick_dropdown[^"]*)"/i) || [])[1] || "";
      const quotedArgs = [...onclick.matchAll(/'([^']*)'/g)].map((arg) => arg[1]);
      const amountText = cols[3] || "";
      const amount = parseMineralAmount(amountText);

      return {
        page,
        dateText: cols[0] || "",
        nickname: cols[1] || "",
        reason: cols[2] || "",
        amountText,
        amount,
        memberId: quotedArgs[1] || "",
      };
    })
    .filter((row) => row.amount !== 0);
}

function rowSignature(row) {
  return [
    row.dateText,
    row.memberId,
    row.nickname,
    row.reason,
    row.amountText,
  ].join("|");
}

function isDonationRow(row) {
  if (row.amount <= 0) return false;
  if (!row.memberId) return false;
  if (SYSTEM_MEMBER_IDS.has(row.memberId)) return false;
  if (row.nickname.trim().toUpperCase() === "YGOSU") return false;
  return true;
}

function makeRanking(rows) {
  const donors = new Map();

  for (const row of rows) {
    const donor = donors.get(row.memberId) || {
      memberId: row.memberId,
      nickname: row.nickname || `회원 ${row.memberId}`,
      totalMineral: 0,
      donationCount: 0,
      latestDateText: row.dateText,
      latestReason: row.reason,
      firstDateText: row.dateText,
    };

    donor.totalMineral += row.amount;
    donor.donationCount += 1;
    donor.firstDateText = row.dateText;

    donors.set(row.memberId, donor);
  }

  return [...donors.values()]
    .sort((a, b) => {
      if (b.totalMineral !== a.totalMineral) return b.totalMineral - a.totalMineral;
      if (b.donationCount !== a.donationCount) return b.donationCount - a.donationCount;
      return Number(a.memberId) - Number(b.memberId);
    })
    .map((donor, index) => ({
      rank: index + 1,
      ...donor,
    }));
}

async function main() {
  const seen = new Set();
  const allRows = [];
  const donationRows = [];
  let duplicatePageStreak = 0;
  let pagesScanned = 0;
  let duplicateRowsSkipped = 0;
  let currentStorage = { text: "", mineral: 0 };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const html = await fetchWithTimeout(pageUrl(page));
    pagesScanned = page;

    if (page === 1) {
      currentStorage = extractCurrentStorage(html);
    }

    const rows = parseRows(html, page);
    let freshRows = 0;

    for (const row of rows) {
      const signature = rowSignature(row);
      if (seen.has(signature)) {
        duplicateRowsSkipped += 1;
        continue;
      }

      seen.add(signature);
      freshRows += 1;
      allRows.push(row);

      if (isDonationRow(row)) {
        donationRows.push(row);
      }
    }

    console.log(
      `[mineral] page ${page} rows=${rows.length} fresh=${freshRows} donations=${donationRows.length}`
    );

    if (freshRows === 0) {
      duplicatePageStreak += 1;
    } else {
      duplicatePageStreak = 0;
    }

    if (duplicatePageStreak >= STOP_AFTER_DUPLICATE_PAGES) {
      break;
    }

    if (page < MAX_PAGES && REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const ranking = makeRanking(donationRows);
  const totalDonatedMineral = donationRows.reduce((sum, row) => sum + row.amount, 0);
  const payload = {
    sourceName: "와이고수 스타대학 미네랄창고",
    sourceUrl: SOURCE_URL,
    collectedAt: new Date().toISOString(),
    currentStorage,
    scan: {
      maxPages: MAX_PAGES,
      pagesScanned,
      rowsScanned: allRows.length,
      donationRows: donationRows.length,
      duplicateRowsSkipped,
    },
    summary: {
      donorCount: ranking.length,
      totalDonatedMineral,
      top100TotalMineral: ranking
        .slice(0, 100)
        .reduce((sum, donor) => sum + donor.totalMineral, 0),
    },
    ranking: ranking.slice(0, 100),
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `[mineral] wrote ${path.relative(process.cwd(), OUTPUT_PATH)} donors=${ranking.length} rows=${donationRows.length}`
  );
}

main().catch((error) => {
  console.error("[mineral] failed:", error);
  process.exitCode = 1;
});
