/**
 * End-of-Day routes
 *
 * POST /eod          — submit an EOD record (restock amount + 2 photos)
 * GET  /eod          — list past EOD records
 * GET  /eod/today    — today's EOD record (if submitted)
 *
 * Images arrive as base64 data URLs in the JSON body.
 * They are stored in the 'eod-receipts' Supabase Storage bucket (private).
 */
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { uploadBase64Image } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

// ── POST /eod ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { restock_amount, receipt_image, deposit_image } = req.body;

    if (!receipt_image || !deposit_image)
      return res
        .status(400)
        .json({ error: "Both receipt and deposit images are required." });

    // Get today's revenue from sales table (the source of truth)
    const revenueResult = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total_revenue
       FROM sales
       WHERE merchant_id = $1 AND logged_at::date = CURRENT_DATE`,
      [req.merchant.id]
    );
    const totalRevenue = parseFloat(revenueResult.rows[0].total_revenue);

    // Upload both images
    const datePath = new Date().toISOString().slice(0, 10);
    const receiptUrl = await uploadBase64Image(
      "eod-receipts",
      `${req.merchant.id}/${datePath}/receipt-${uuidv4()}.jpg`,
      receipt_image
    );
    const depositUrl = await uploadBase64Image(
      "eod-receipts",
      `${req.merchant.id}/${datePath}/deposit-${uuidv4()}.jpg`,
      deposit_image
    );

    // Upsert — re-submitting the same day overwrites the previous record
    const { rows } = await pool.query(
      `INSERT INTO eod_records
         (merchant_id, trading_date, total_revenue, restock_amount, receipt_url, deposit_url)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
       ON CONFLICT (merchant_id, trading_date) DO UPDATE SET
         total_revenue  = EXCLUDED.total_revenue,
         restock_amount = EXCLUDED.restock_amount,
         receipt_url    = EXCLUDED.receipt_url,
         deposit_url    = EXCLUDED.deposit_url,
         submitted_at   = NOW()
       RETURNING id, trading_date, total_revenue, restock_amount,
                 remaining_cash, submitted_at`,
      [req.merchant.id, totalRevenue, parseFloat(restock_amount) || 0, receiptUrl, depositUrl]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /eod error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ── GET /eod/today ────────────────────────────────────────────────────────
router.get("/today", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, trading_date, total_revenue, restock_amount,
              remaining_cash, submitted_at
       FROM eod_records
       WHERE merchant_id = $1 AND trading_date = CURRENT_DATE`,
      [req.merchant.id]
    );
    if (rows.length === 0)
      return res.json({ submitted: false });

    res.json({ submitted: true, record: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// ── GET /eod ──────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, trading_date, total_revenue, restock_amount,
              remaining_cash, submitted_at
       FROM eod_records
       WHERE merchant_id = $1
       ORDER BY trading_date DESC
       LIMIT 90`,  // last 90 days
      [req.merchant.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
