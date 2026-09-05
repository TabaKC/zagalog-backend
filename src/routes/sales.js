/**
 * Sales routes
 *
 * POST /sales          — log a completed cash sale
 * GET  /sales          — list sales (optional ?date=YYYY-MM-DD filter)
 * GET  /sales/today    — today's summary (total, count, top sellers)
 */
const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// ── POST /sales ───────────────────────────────────────────────────────────
// Body: { items: [{ product_id, product_name, price, qty }], total }
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, total } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "Sale must have at least one item." });
    if (typeof total !== "number" || total <= 0)
      return res.status(400).json({ error: "Invalid total." });

    await client.query("BEGIN");

    // Insert the sale
    const saleResult = await client.query(
      `INSERT INTO sales (merchant_id, total, cart_snapshot)
       VALUES ($1, $2, $3)
       RETURNING id, total, logged_at`,
      [req.merchant.id, total, JSON.stringify(items)]
    );
    const sale = saleResult.rows[0];

    // Insert the line items
    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, price, qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          sale.id,
          item.product_id || null,
          item.product_name,
          parseFloat(item.price),
          parseInt(item.qty, 10),
        ]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(sale);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /sales error:", err.message);
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// ── GET /sales ────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { date } = req.query; // optional YYYY-MM-DD
    let query = `
      SELECT s.id, s.total, s.logged_at,
             json_agg(json_build_object(
               'product_name', si.product_name,
               'price', si.price,
               'qty', si.qty
             )) AS items
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.merchant_id = $1
    `;
    const params = [req.merchant.id];

    if (date) {
      query += ` AND s.logged_at::date = $2`;
      params.push(date);
    }

    query += ` GROUP BY s.id ORDER BY s.logged_at DESC LIMIT 200`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// ── GET /sales/today ──────────────────────────────────────────────────────
router.get("/today", async (req, res) => {
  try {
    // Today's totals
    const totalsResult = await pool.query(
      `SELECT
         COUNT(*)::int          AS sale_count,
         COALESCE(SUM(total),0) AS total_revenue
       FROM sales
       WHERE merchant_id = $1
         AND logged_at::date = CURRENT_DATE`,
      [req.merchant.id]
    );

    // Top 5 sellers today
    const topResult = await pool.query(
      `SELECT si.product_name, SUM(si.qty)::int AS qty_sold
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.merchant_id = $1
         AND s.logged_at::date = CURRENT_DATE
       GROUP BY si.product_name
       ORDER BY qty_sold DESC
       LIMIT 5`,
      [req.merchant.id]
    );

    const { sale_count, total_revenue } = totalsResult.rows[0];
    const avg_sale = sale_count > 0 ? total_revenue / sale_count : 0;

    res.json({
      date: new Date().toISOString().slice(0, 10),
      sale_count,
      total_revenue: parseFloat(total_revenue),
      avg_sale: parseFloat(avg_sale.toFixed(2)),
      top_sellers: topResult.rows,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
