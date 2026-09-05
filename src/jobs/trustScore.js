/**
 * trustScore.js — nightly job that recomputes trust profiles.
 *
 * Run via cron on Railway:
 *   Schedule: 0 1 * * *   (1 AM SAST every night)
 *   Command:  node src/jobs/trustScore.js
 *
 * Algorithm
 * ─────────
 * For each merchant who has traded in the last 90 days:
 *
 *   1. active_trading_days  = distinct days with at least one sale
 *   2. match_rate_pct       = (days with completed EOD) / active_trading_days × 100
 *   3. avg_daily_revenue    = total revenue / active_trading_days
 *   4. avg_basket_size      = total revenue / total transactions
 *   5. trust_score          = weighted composite:
 *        40% match rate
 *        30% trading consistency (active days / 90)
 *        20% transaction volume score (capped at 300 txns/month → 100%)
 *        10% longevity (months since account created, capped at 12)
 */
require("dotenv").config();
const pool = require("../db/pool");

const PERIOD_DAYS = 90;

async function computeTrustScores() {
  const client = await pool.connect();
  try {
    console.log(`[${new Date().toISOString()}] Starting trust score computation…`);

    // Find all merchants who have traded in the last PERIOD_DAYS days
    const { rows: merchants } = await client.query(`
      SELECT DISTINCT merchant_id
      FROM sales
      WHERE logged_at >= NOW() - INTERVAL '${PERIOD_DAYS} days'
    `);

    console.log(`Found ${merchants.length} active merchant(s).`);

    for (const { merchant_id } of merchants) {
      try {
        await computeForMerchant(client, merchant_id);
      } catch (err) {
        console.error(`Failed for merchant ${merchant_id}:`, err.message);
      }
    }

    console.log("✓ Trust score computation complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

async function computeForMerchant(client, merchantId) {
  const periodEnd = new Date();
  const periodStart = new Date(Date.now() - PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const periodStartStr = periodStart.toISOString().slice(0, 10);

  // 1. Sales stats
  const salesStats = await client.query(
    `SELECT
       COUNT(*)::int                       AS total_transactions,
       COALESCE(SUM(total), 0)             AS total_revenue,
       COUNT(DISTINCT logged_at::date)::int AS active_trading_days
     FROM sales
     WHERE merchant_id = $1
       AND logged_at::date >= $2`,
    [merchantId, periodStartStr]
  );
  const {
    total_transactions,
    total_revenue,
    active_trading_days,
  } = salesStats.rows[0];

  if (active_trading_days === 0) return; // nothing to compute

  // 2. EOD match rate
  const eodStats = await client.query(
    `SELECT COUNT(*)::int AS eod_days
     FROM eod_records
     WHERE merchant_id = $1
       AND trading_date >= $2
       AND receipt_url IS NOT NULL
       AND deposit_url IS NOT NULL`,
    [merchantId, periodStartStr]
  );
  const eod_days = eodStats.rows[0].eod_days;
  const match_rate_pct = (eod_days / active_trading_days) * 100;

  // 3. Averages
  const avg_daily_revenue = total_revenue / active_trading_days;
  const avg_basket_size = total_transactions > 0
    ? total_revenue / total_transactions
    : 0;

  // 4. Merchant longevity
  const merchantInfo = await client.query(
    `SELECT created_at FROM merchants WHERE id = $1`,
    [merchantId]
  );
  const createdAt = new Date(merchantInfo.rows[0].created_at);
  const monthsActive = Math.min(
    (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30),
    12
  );

  // 5. Trust score (0–100)
  const consistency = Math.min(active_trading_days / PERIOD_DAYS, 1);
  const volumeScore = Math.min(total_transactions / (300 * 3), 1); // 900 txns over 90d = 100%
  const longevityScore = monthsActive / 12;

  const trust_score = Math.round(
    match_rate_pct * 0.40 +
    consistency * 100 * 0.30 +
    volumeScore * 100 * 0.20 +
    longevityScore * 100 * 0.10
  );

  // 6. Upsert into trust_profiles
  await client.query(
    `INSERT INTO trust_profiles
       (merchant_id, period_start, period_end,
        avg_daily_revenue, avg_basket_size,
        total_transactions, active_trading_days, days_in_period,
        match_rate_pct, trust_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      merchantId,
      periodStartStr,
      periodEnd.toISOString().slice(0, 10),
      avg_daily_revenue.toFixed(2),
      avg_basket_size.toFixed(2),
      total_transactions,
      active_trading_days,
      PERIOD_DAYS,
      match_rate_pct.toFixed(2),
      trust_score,
    ]
  );

  console.log(
    `  ✓ Merchant ${merchantId}: trust=${trust_score}% match=${match_rate_pct.toFixed(1)}% days=${active_trading_days}`
  );
}

computeTrustScores().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
