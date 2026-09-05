/**
 * migrate.js — run once to create all tables.
 * Usage: node src/db/migrate.js
 */
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
-- ============================================================
--  EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
--  MERCHANTS
--  One row per trader. sa_id_hash is a bcrypt hash of their
--  SA ID number — we never store the raw ID.
-- ============================================================
CREATE TABLE IF NOT EXISTS merchants (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number      TEXT UNIQUE NOT NULL,         -- e.g. +27821234567
  sa_id_hash        TEXT,                         -- bcrypt hash, nullable until verified
  full_name         TEXT,
  business_name     TEXT,
  location          TEXT,
  verified          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at    TIMESTAMPTZ
);

-- ============================================================
--  OTP CODES
--  Short-lived one-time passwords for phone-based login.
-- ============================================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number TEXT NOT NULL,
  code         TEXT NOT NULL,               -- 6-digit code (hashed)
  expires_at   TIMESTAMPTZ NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes (phone_number);

-- ============================================================
--  PRODUCTS (inventory)
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  image_url   TEXT,                         -- Supabase Storage public URL
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_merchant ON products (merchant_id);

-- ============================================================
--  SALES
--  One row per "Log cash sale" tap.
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  total       NUMERIC(10,2) NOT NULL,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- snapshot of the cart at the moment of the sale,
  -- so we keep the record even if a product is later deleted
  cart_snapshot JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_sales_merchant_date
  ON sales (merchant_id, logged_at DESC);

-- ============================================================
--  SALE ITEMS
--  Normalised line items — one row per product per sale.
-- ============================================================
CREATE TABLE IF NOT EXISTS sale_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id      UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,    -- denormalised for historical accuracy
  price        NUMERIC(10,2) NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);

-- ============================================================
--  END-OF-DAY RECORDS
--  One row per trader per calendar day.
-- ============================================================
CREATE TABLE IF NOT EXISTS eod_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  trading_date    DATE NOT NULL,
  total_revenue   NUMERIC(10,2) NOT NULL DEFAULT 0,
  restock_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  remaining_cash  NUMERIC(10,2) GENERATED ALWAYS AS (total_revenue - restock_amount) STORED,
  receipt_url     TEXT,           -- Supabase Storage URL of restock receipt photo
  deposit_url     TEXT,           -- Supabase Storage URL of bank deposit slip photo
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, trading_date)
);
CREATE INDEX IF NOT EXISTS idx_eod_merchant ON eod_records (merchant_id, trading_date DESC);

-- ============================================================
--  TRUST PROFILES
--  Computed nightly. One row per merchant per computation run.
--  The latest row is the current trust profile.
-- ============================================================
CREATE TABLE IF NOT EXISTS trust_profiles (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id           UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  period_start          DATE NOT NULL,
  period_end            DATE NOT NULL,
  avg_daily_revenue     NUMERIC(10,2),
  avg_basket_size       NUMERIC(10,2),
  total_transactions    INTEGER,
  active_trading_days   INTEGER,
  days_in_period        INTEGER,
  match_rate_pct        NUMERIC(5,2),   -- % of sales days with a completed EOD
  trust_score           NUMERIC(5,2),   -- 0–100
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trust_merchant
  ON trust_profiles (merchant_id, computed_at DESC);

-- ============================================================
--  HELPER: auto-update updated_at on products
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Running migrations…");
    await client.query(SQL);
    console.log("✓ All tables created / verified.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
