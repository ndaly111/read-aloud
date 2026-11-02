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
