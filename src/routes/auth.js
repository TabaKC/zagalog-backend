/**
 * Auth routes
 *
 * POST /auth/request-otp   — send a 6-digit OTP to a phone number
 * POST /auth/verify-otp    — verify the OTP, return a JWT
 * GET  /auth/me            — return the current merchant's profile
 * PUT  /auth/me            — update business name / location / SA ID
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { generateOtp, sendOtp } = require("../services/sms");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Normalise SA numbers to E.164 (+27...)
function normalisePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("27") && digits.length === 11) return "+" + digits;
  if (digits.startsWith("0") && digits.length === 10)
    return "+27" + digits.slice(1);
  throw new Error(
    "Invalid phone number. Use 0821234567 or +27821234567 format."
  );
}

// ── POST /auth/request-otp ────────────────────────────────────────────────
router.post("/request-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone number required." });

    const phoneNumber = normalisePhone(phone);
    const code = generateOtp();
    const hashed = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Upsert the merchant record so they exist before verification
    await pool.query(
      `INSERT INTO merchants (phone_number) VALUES ($1)
       ON CONFLICT (phone_number) DO UPDATE SET last_active_at = NOW()`,
      [phoneNumber]
    );

    // Store the OTP (invalidate any prior unused codes for this number)
    await pool.query(
      `UPDATE otp_codes SET used = TRUE
       WHERE phone_number = $1 AND used = FALSE`,
      [phoneNumber]
    );
    await pool.query(
      `INSERT INTO otp_codes (phone_number, code, expires_at)
       VALUES ($1, $2, $3)`,
      [phoneNumber, hashed, expiresAt]
    );

    await sendOtp(phoneNumber, code);

    res.json({ message: "OTP sent.", phone: phoneNumber });
  } catch (err) {
    console.error("request-otp error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── POST /auth/verify-otp ─────────────────────────────────────────────────
router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code)
      return res.status(400).json({ error: "Phone and code required." });

    const phoneNumber = normalisePhone(phone);

    // Fetch the most recent unused, unexpired OTP
    const { rows } = await pool.query(
      `SELECT id, code FROM otp_codes
       WHERE phone_number = $1
         AND used = FALSE
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [phoneNumber]
    );

    if (rows.length === 0)
      return res.status(401).json({ error: "OTP expired or not found." });

    const valid = await bcrypt.compare(code, rows[0].code);
    if (!valid)
      return res.status(401).json({ error: "Incorrect OTP." });

    // Mark OTP as used
    await pool.query(`UPDATE otp_codes SET used = TRUE WHERE id = $1`, [
      rows[0].id,
    ]);

    // Mark merchant as verified
    const merchantResult = await pool.query(
      `UPDATE merchants SET verified = TRUE, last_active_at = NOW()
       WHERE phone_number = $1
       RETURNING id, phone_number, full_name, business_name, location, verified`,
      [phoneNumber]
    );
    const merchant = merchantResult.rows[0];

    // Issue JWT
    const token = jwt.sign(
      { sub: merchant.id, phone: merchant.phone_number },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
    );

    res.json({ token, merchant });
  } catch (err) {
    console.error("verify-otp error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, phone_number, full_name, business_name, location,
              verified, created_at
       FROM merchants WHERE id = $1`,
      [req.merchant.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Merchant not found." });

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// ── PUT /auth/me ──────────────────────────────────────────────────────────
router.put("/me", requireAuth, async (req, res) => {
  try {
    const { full_name, business_name, location, sa_id } = req.body;

    let saIdHash = undefined;
    if (sa_id) {
      // Basic SA ID validation: 13 digits
      if (!/^\d{13}$/.test(sa_id))
        return res.status(400).json({ error: "SA ID must be 13 digits." });
      saIdHash = await bcrypt.hash(sa_id, 10);
    }

    const { rows } = await pool.query(
      `UPDATE merchants SET
         full_name     = COALESCE($1, full_name),
         business_name = COALESCE($2, business_name),
         location      = COALESCE($3, location),
         sa_id_hash    = COALESCE($4, sa_id_hash)
       WHERE id = $5
       RETURNING id, phone_number, full_name, business_name, location, verified`,
      [full_name || null, business_name || null, location || null, saIdHash || null, req.merchant.id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /me error:", err.message);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
