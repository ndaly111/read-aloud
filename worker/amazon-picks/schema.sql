-- Amazon picks strip. No visitor data of any kind: product facts and aggregate counters only.
-- Run remotely with: npx wrangler d1 execute read-aloud-picks --remote --file schema.sql

-- Product facts fetched from the Amazon Creators API (title, image, price, tagged URL).
-- Rows exist only for catalog entries with an ASIN; search/bounty entries never need one.
CREATE TABLE IF NOT EXISTS pick_items (
  asin TEXT PRIMARY KEY,
  title TEXT,
  image TEXT,
  price TEXT,
  url TEXT,
  updated_at INTEGER NOT NULL
);

-- Aggregate exposure/click counts per UTC hour index / pick / event. No identifiers.
CREATE TABLE IF NOT EXISTS pick_events (
  hour INTEGER NOT NULL,
  pick TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, pick, event)
);

-- Last catalog refresh attempt: when, and whether Amazon let us in.
CREATE TABLE IF NOT EXISTS pick_refresh (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ran_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);

-- Which catalog picks are active (in the hourly rotation) vs on the bench. `since` orders
-- the bench (oldest promoted first) and records when a pick last changed status.
CREATE TABLE IF NOT EXISTS pick_pool (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'bench')),
  since INTEGER NOT NULL
);

-- Weekly rotation log: what was benched and promoted, or why nothing changed.
CREATE TABLE IF NOT EXISTS pick_rotations (
  ran_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);

-- Same aggregate counts keyed by which stock photo (1-based) was on the card, so the photos
-- of one pick can be compared. 0 = Amazon's own product image, not recorded here.
CREATE TABLE IF NOT EXISTS pick_photo_events (
  hour INTEGER NOT NULL,
  pick TEXT NOT NULL,
  photo INTEGER NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, pick, photo, event)
);

-- Wording tests: aggregate counts per UTC hour / pick / test version / event. No identifiers.
CREATE TABLE IF NOT EXISTS pick_variant_events (
  hour INTEGER NOT NULL,
  pick TEXT NOT NULL,
  variant TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, pick, variant, event)
);

-- Wording-test versions retired by the pruning rule (pruneVariants in src/index.js).
CREATE TABLE IF NOT EXISTS pick_variant_status (
  pick TEXT NOT NULL,
  variant TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (pick, variant)
);
