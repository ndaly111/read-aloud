# Monthly support goal A/B test — operating record

**Status: NOT LIVE / pending verification and approval (October 7, 2026).**
Experiment: support_goal_2026_10. Owner: Read-Aloud operator.
Source: donation-experiment.js, donation-experiment.css, worker/donation-goal/,
index.html. This file is the permanent experiment record; do not rely on chat context.

## Design
- A: existing support-strip wording and existing Buy Me a Coffee link.
- B: same position, verified USD month-to-date progress/goal, revised appeal.
- 50/50 random assignment. It persists for a tab session; only consenting
  visitors also retain the assignment in localStorage across visits.
- Fail closed: if the verified goal API is unavailable, EVERYONE sees the
  original appeal, no enrollment or experiment tracking occurs.
- No change to the text-to-speech tool, prices, donations flow or advertising.
- Hypothesis: B increases completed eligible contributions per exposed user.

## Mandatory pre-launch tasks
- [ ] Owner approves the final visitor-facing words and Latest updates entry,
      as required by CLAUDE.md. Branch/PR is not a live launch.
- [ ] Owner validates actual monthly costs and chooses an honest goal amount.
      The earlier $100 example was illustrative, not a confirmed expense.
- [ ] Check wording/privacy (including existing "no tracking" claim).
- [ ] Create Cloudflare D1 database and signed BMC webhook; see below.
- [ ] Reconcile this month's successful USD one-time gifts and refunds to
      a known cutoff before enabling the public goal. Audit after each refund.
- [ ] Validate completed-donation attribution by variant. Buy Me a Coffee
      webhook documentation does NOT include experiment variant data.
      A click or overall donations total is not an attributed conversion.
- [ ] Add GA4 event-scoped custom dimensions experiment_id and variant_id;
      verify both donation_experiment_view and donation_experiment_click.
- [ ] QA desktop/mobile, keyboard, consent/no consent, offline goal endpoint,
      ad blockers, slow network, real donation, refund and TTS playback.
- [ ] Record LIVE launch timestamp and populate ledger below.

## Verified live-goal setup
1. In worker/donation-goal run: npx wrangler d1 create read-aloud-donations.
   Copy returned ID into the uncommented D1 binding in wrangler.toml.
2. Run: npx wrangler d1 execute read-aloud-donations --remote --file=schema.sql.
3. Run: npx wrangler secret put BMC_WEBHOOK_SECRET. Do not commit secret.
4. Deploy: npx wrangler deploy. Verify the Worker URL; the client expects
   https://read-aloud-donation-goal.ndaly111.workers.dev/goal.
5. Buy Me a Coffee -> Integrations -> Webhooks: register Worker /webhook,
   subscribe donation.created and donation.refunded; test event must not count.
6. Verify dashboard paid one-time donations in USD, net of refunds.
   Set BASELINE_MONTH (YYYY-MM), BASELINE_CENTS and
   BASELINE_THROUGH_UNIX to the verified amount and cutoff, to avoid
   counting earlier contributions twice. Record these values below.
7. Set GOAL_USD to the approved actual target, GOAL_DATA_VERIFIED to true;
   redeploy and verify GET /goal returns ready true and accurate total.
8. Verify the next real donation/retry/refund matches the dashboard.
   Donations in non-USD currencies and recurring subscription activity are
   NOT yet included in the goal API. Reconcile those externally and label
   the claim accurately. The database stores no supporter names/emails.
9. On each new UTC month, verify the opening amount and reconcile the
   previous month's late refunds. Kill switch if totals become uncertain:
   set GOAL_DATA_VERIFIED=false and redeploy.

## Metrics and decision rules
Primary outcome, ONLY when an actual BMC completed-payment -> variant join
has been independently validated: paid gifts per unique exposed user and
net USD per 1,000 unique exposed users, A versus B.

Secondary: donation-button clickthrough, A versus B (diagnostic only).
Guardrails: playback starts/failures, consent errors, mobile usability,
reader feedback, and repeat visits.

GA4 events: donation_experiment_view; donation_experiment_click.
Properties: experiment_id; variant_id.
GA modeled/cookieless data may not be accurate unique users. Compare
consistent denominators and exclude tests; never send pasted text,
filenames or donor personal details.

**Attribution blocker:** The BMC webhook goal is the aggregate of ALL
eligible account donations, regardless of site variant or outside source.
It cannot prove which appeal caused any payment. Explore BMC's GA4
integration and test end-to-end campaign attribution through a real
completed purchase before drawing donation efficacy conclusions. If
unavailable, the test can compare clicks but donation result is
INCONCLUSIVE, not "A won" or "B won".

Fixed formal looks after launch: day 7, 14, 28, and 42. Check basic
health on day 1 and review payment reconciliation every 2–3 days.
Start dates FROM ACTUAL DEPLOYMENT, not PR creation.

Stop immediately for false published totals, privacy issues,
misleading claims, consent regressions or playback failures.
For an early DONATION winner on a formal look, require all of:
- Verified per-variant completed payment attribution and comparable
  unique exposure denominators.
- At least 15 completed donations IN EACH arm.
- At least 20% practical improvement in donation conversion rate.
- Two-sided Fisher exact test p < 0.0125 (four planned looks,
  Bonferroni adjustment), and no material guardrail regressions.
- Both weekday/weekend traffic represented.

If criteria are unmet: continue to next scheduled checkpoint; don't
stop on clicks or an exciting graph. At 42 days declare inconclusive
if underpowered or attribution unavailable; default to the existing
less intrusive version and design the next smaller test. If a winner
is genuinely verified, roll it out, remove A/B allocation, preserve
accurate goal tracking, and monitor 14 more days.

## Ledger
Only real verified amounts go here; NA means missing attribution
(NOT zero).

| Review | Date | A exposed | B exposed | A clicks | B clicks | A completed gifts | B completed gifts | A net USD | B net USD | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Launch | TBD | NA | NA | NA | NA | NA | NA | NA | NA | Not launched |
| +1 day | TBD | NA | NA | NA | NA | NA | NA | NA | NA | QA |
| +7 days | TBD | NA | NA | NA | NA | NA | NA | NA | NA | Formal look 1 |
| +14 days | TBD | NA | NA | NA | NA | NA | NA | NA | NA | Formal look 2 |
| +28 days | TBD | NA | NA | NA | NA | NA | NA | NA | NA | Formal look 3 |
| +42 days | TBD | NA | NA | NA | NA | NA | NA | NA | NA | Final look |

Activation checklist:
- Approved goal: TBD.
- Baseline month, amount, reconciliation timestamp: TBD.
- Attribution join mechanism/verification: TBD.
- GA custom dimensions: TBD.
- Live deployment date: TBD.

## Decision log
2026-10-07 — staged implementation and conservative stopping rules.
No public fundraiser progress or experiment exposure has been claimed.

2026-10-07 — Basic isolated checks: the client preserved A, rendered B when a
verified goal response was supplied, and left the page unassigned when the
feed was disabled. The Worker returned ready:false while unverified and an
aggregate response with a mock database when verified. These are MOCK checks,
not a live webhook/payment or browser end-to-end test.
