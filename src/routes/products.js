/**
 * Products routes
 *
 * GET    /products          — list all active products for this merchant
 * POST   /products          — create a product (name, price, base64 image)
 * PUT    /products/:id      — update name / price / image
 * DELETE /products/:id      — soft-delete (sets active = false)
 */
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { uploadBase64Image } = require("../services/storage");

const router = express.Router();
router.use(requireAuth);

// ── GET /products ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, price, image_url, created_at
       FROM products
       WHERE merchant_id = $1 AND active = TRUE
       ORDER BY created_at ASC`,
      [req.merchant.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// ── POST /products ────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { name, price, image } = req.body; // image = base64 data URL

    if (!name || !price)
      return res.status(400).json({ error: "Name and price are required." });
    if (parseFloat(price) <= 0)
      return res.status(400).json({ error: "Price must be greater than 0." });

    let imageUrl = null;
    if (image) {
      const filename = `${req.merchant.id}/${uuidv4()}.jpg`;
      imageUrl = await uploadBase64Image("product-images", filename, image);
    }

    const { rows } = await pool.query(
      `INSERT INTO products (merchant_id, name, price, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, price, image_url, created_at`,
      [req.merchant.id, name.trim(), parseFloat(price), imageUrl]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /products error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ── PUT /products/:id ─────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { name, price, image } = req.body;

    // Ensure this product belongs to the requesting merchant
    const check = await pool.query(
      `SELECT id FROM products WHERE id = $1 AND merchant_id = $2 AND active = TRUE`,
      [req.params.id, req.merchant.id]
    );
    if (check.rows.length === 0)
      return res.status(404).json({ error: "Product not found." });

    let imageUrl = undefined;
    if (image) {
      const filename = `${req.merchant.id}/${req.params.id}.jpg`;
      imageUrl = await uploadBase64Image("product-images", filename, image);
    }

    const { rows } = await pool.query(
      `UPDATE products SET
         name      = COALESCE($1, name),
         price     = COALESCE($2, price),
         image_url = COALESCE($3, image_url)
       WHERE id = $4
       RETURNING id, name, price, image_url, updated_at`,
      [
        name ? name.trim() : null,
        price ? parseFloat(price) : null,
        imageUrl || null,
        req.params.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /products/:id error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

// ── DELETE /products/:id ──────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE products SET active = FALSE
       WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.merchant.id]
    );
    if (rowCount === 0)
      return res.status(404).json({ error: "Product not found." });
    res.json({ message: "Product removed." });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
