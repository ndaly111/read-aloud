-- Only non-personal transaction facts. Run remotely with wrangler d1 execute.
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  refunded INTEGER NOT NULL DEFAULT 0 CHECK (refunded IN (0, 1))
);
CREATE INDEX IF NOT EXISTS donations_month ON donations (created_at, refunded);

-- Aggregate experiment counters only: no identifiers, no per-visitor rows.
CREATE TABLE IF NOT EXISTS experiment_events (
  day TEXT NOT NULL,
  variant TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, variant, event)
);
