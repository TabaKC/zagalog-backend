/**
 * Trust routes
 *
 * GET /trust/profile   — return the merchant's latest computed trust profile
 *                        (from the trust_profiles table, updated nightly)
 */
const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/profile", async (req, res) => {
  try {
    // Latest computed trust profile
    const trustResult = await pool.query(
      `SELECT tp.*, m.business_name, m.full_name, m.location
       FROM trust_profiles tp
       JOIN merchants m ON m.id = tp.merchant_id
       WHERE tp.merchant_id = $1
       ORDER BY tp.computed_at DESC
       LIMIT 1`,
      [req.merchant.id]
    );

    if (trustResult.rows.length === 0) {
      // No trust profile yet — return raw stats so the UI isn't empty
      return res.json({ computed: false, message: "Trust profile not yet computed. Keep logging sales." });
    }

    const profile = trustResult.rows[0];

    // Mask the SA ID — we never expose the hash or raw value
    res.json({
      computed: true,
      business_name: profile.business_name,
      full_name: profile.full_name,
      location: profile.location,
      period_start: profile.period_start,
      period_end: profile.period_end,
      avg_daily_revenue: profile.avg_daily_revenue,
      avg_basket_size: profile.avg_basket_size,
      total_transactions: profile.total_transactions,
      active_trading_days: profile.active_trading_days,
      days_in_period: profile.days_in_period,
      match_rate_pct: profile.match_rate_pct,
      trust_score: profile.trust_score,
      computed_at: profile.computed_at,
    });
  } catch (err) {
    console.error("GET /trust/profile error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
