# Monthly support goal test — operating record

**Status: NOT LIVE / pending verification and approval (October 7, 2026).**
Experiment: support_goal_2026_10. Owner: Read-Aloud operator.
Source: donation-experiment.js, donation-experiment.css, worker/donation-goal/,
index.html. This file is the permanent experiment record; do not rely on chat context.

## Design
- A: existing support-strip wording and existing Buy Me a Coffee link.
- B: same position, verified USD month-to-date progress toward a $50 goal.
- C: same position, verified USD month-to-date progress toward a $100 goal.
- Equal 1/3 random assignment across A/B/C. It persists for a tab session; only consenting
  visitors also retain the assignment in localStorage across visits.
- Fail closed: if the verified goal API is unavailable, EVERYONE sees the
  original appeal, no enrollment or experiment tracking occurs.
- Enrollment also requires an explicit launch timestamp, experiment enable
  switch and verified attribution switch. It ends automatically at day 42.
- Goal requests time out after four seconds. Responses must be current within
  five minutes and refer to the current UTC month. A new month requires a
  fresh ledger reconciliation before the progress display resumes.
- Accepting analytics consent retains the current assignment; rejecting or
  resetting it removes the saved assignment, including changes in another tab.
- No change to the text-to-speech tool, prices, donations flow or advertising.
- Hypothesis: goal-based appeals improve completed donation conversion; compare
  each goal with the control and compare $50 with $100. Both goal variants use
  the same verified account-wide total, month, wording, button and placement.
  Freeze both targets throughout the test; these are fundraising targets,
  not claims that monthly expenses equal $50 or $100.

## Mandatory pre-launch tasks
- [ ] Owner approves the final visitor-facing words and Latest updates entry,
      as required by CLAUDE.md. Branch/PR is not a live launch.
- [x] Owner selected two fundraising targets, $50 and $100, on October 7, 2026.
      Do not claim either is an exact expense amount or invent separate balances.
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
6. Import this month's individual paid one-time USD payment facts into D1
   (id, original created_at Unix seconds, amount_cents, refunded 0/1).
   Include refunded payments; compare the sum of unrefunded payments with
   the dashboard. Do not store names, emails, messages or raw webhook bodies.
   Use the BMC payment data.id as the primary key, not the webhook event ID.
   Importing a verified opening ledger uses the same rows as future webhooks;
   a late refund therefore reduces the total and a retry adds nothing.
   Do not use a lump-sum baseline: it cannot handle individual late refunds.
7. Keep GOAL_B_USD=50 and GOAL_C_USD=100 fixed. Set GOAL_VERIFIED_MONTH to the
   reconciled UTC YYYY-MM and GOAL_DATA_VERIFIED to true. Redeploy and verify
   GET /goal returns ready:true and an accurate total. The experiment remains
   inactive until all other launch tasks are complete.
8. Verify the next real donation/retry/refund matches the dashboard.
   Donations in non-USD currencies and recurring subscription activity are
   NOT yet included in the goal API. Reconcile those externally and label
   the claim accurately. The database stores no supporter names/emails.
9. After completed-payment attribution is independently verified, set
   ATTRIBUTION_VERIFIED=true, EXPERIMENT_ENABLED=true and
   EXPERIMENT_LAUNCH_UTC to the actual launch timestamp, e.g. an ISO UTC value
   ending in Z. Redeploy and verify experiment_active:true. Record launch below.
   UTM parameters, link clicks and donation timestamps alone are not proof of
   payment-to-variant attribution. No such attribution is invented by this code.
10. On each new UTC month, import/reconcile the new opening ledger and set
   GOAL_VERIFIED_MONTH accordingly. Until then the existing appeal appears.
   Refunds remain attached to their original payment month, including late ones.
   Kill switches: EXPERIMENT_ENABLED=false stops allocation; GOAL_DATA_VERIFIED=false
   hides uncertain totals. Both require redeployment.

Webhook contract: [official BMC specification](https://cdn.buymeacoffee.com/assets/integrations/bmc-webhooks-openapi.json).
Amounts are original gross USD gifts less full refunds, **before platform and
processing fees**; they are not net payouts. Memberships, non-USD gifts and partial
refunds without a documented amount cannot be inferred. Reconcile such cases
and disable the verified display if the supported aggregate becomes inaccurate.
Unknown/invalid payment facts receive 400, conflicting amounts/timestamps 409,
invalid signatures 401, oversize payloads 413 and temporary database failures 503.
BMC automatically disables delivery after repeated failures; inspect its delivery
history regularly. A dashboard test cannot change the public total.

## Metrics and decision rules
Primary outcome, ONLY when an actual BMC completed-payment -> variant join
has been independently validated: unique completed donors per unique exposed user.
Count a donor once in each arm; multiple payments are not independent conversions.
Report net USD per 1,000 unique exposed users separately for A, B and C. A Fisher
test of donor conversion does not establish statistical significance for revenue.

Secondary: donation-button clickthrough for A, B and C (diagnostic only).
Guardrails: playback starts/failures, consent errors, mobile usability,
reader feedback, and repeat visits.

GA4 events: donation_experiment_view; donation_experiment_click.
Properties: experiment_id; variant_id.
GA modeled/cookieless data may not be accurate unique users. Restrict the primary
analysis to verified comparable unique users (for example, consenting users with
validated cross-domain attribution). Do not divide donation counts by impression
events, clicks, modeled users or unrelated site traffic. Compare
consistent denominators and exclude tests; never send pasted text,
filenames or donor personal details.

**Attribution blocker:** The BMC webhook goal is the aggregate of ALL
eligible account donations, regardless of site variant or outside source.
It cannot prove which appeal caused any payment. Explore BMC's GA4
integration and test end-to-end campaign attribution through a real
completed purchase before drawing donation efficacy conclusions. If
unavailable, the test can compare clicks but donation result is
INCONCLUSIVE, not a winner for any variant.

Fixed formal looks after launch: day 7, 14, 28, and 42. Check basic
health on day 1 and review payment reconciliation every 2–3 days.
Start dates FROM ACTUAL DEPLOYMENT, not PR creation.

An active Codex thread follow-up, `review-read-aloud-donation-experiment`,
is scheduled for Wednesdays at 9 a.m. America/New_York for six runs.
It checks launch prerequisites while inactive and reports available verified
results after launch. The calendar schedule does not replace formal looks
measured from actual launch. Extend/reschedule it if deployment is delayed;
do not treat the end of six calendar reminders as six weeks of experiment data.

Stop immediately for false published totals, privacy issues,
misleading claims, consent regressions or playback failures.
For an early DONATION winner on a formal look, require all of:
- Verified per-variant completed payment attribution and comparable
  unique exposure denominators.
- At least 15 unique completed donors IN EACH arm.
- The candidate beats BOTH other variants by at least 20% in donation conversion.
- Two-sided Fisher exact test p < 0.05/12 (approximately 0.004167) for BOTH
  candidate comparisons: four planned looks times three pairwise comparisons,
  with Bonferroni adjustment and no material guardrail regressions.
- Both weekday/weekend traffic represented.

If criteria are unmet: continue to next scheduled checkpoint; don't
stop on clicks or an exciting graph. At 42 days declare inconclusive
if underpowered or attribution unavailable; default to the existing
less intrusive version and design the next smaller test. If a winner
is genuinely verified, roll it out, remove experiment allocation, preserve
accurate goal tracking, and monitor 14 more days.

## Ledger
Only real verified amounts go here; NA means missing attribution
(NOT zero).

| Review | Date | Decision |
|---|---|---|
| Launch | TBD | Not launched |
| +1 day | TBD | QA |
| +7 days | TBD | Formal look 1 |
| +14 days | TBD | Formal look 2 |
| +28 days | TBD | Formal look 3 |
| +42 days | TBD | Final look |

Copy the following metrics table for each review and date it. Record unique
completed donors for conversion analysis; total payment count is separate.

| Variant | Appeal | Unique exposed | Click events | Unique completed donors | Net USD |
|---|---|---:|---:|---:|---:|
| A | Existing appeal | NA | NA | NA | NA |
| B | $50 goal | NA | NA | NA | NA |
| C | $100 goal | NA | NA | NA | NA |

Record all three comparison p-values and relative lifts (A/B, A/C, B/C) in
the review notes. Beating the control alone is insufficient to choose one
target over the other; similar goal results remain inconclusive.

## Reproducible review command

Save an operator-only JSON file outside the public site with this structure.
Replace timestamps and counts with verified data; null means missing, not zero.
`net_cents` is attributable USD revenue after refunds, using the same fee basis
for both arms. `clicks` counts click events and can exceed exposed users.

```json
{
  "launch_at": "ACTUAL ISO UTC LAUNCH TIMESTAMP",
  "review_at": "ACTUAL ISO UTC REVIEW TIMESTAMP",
  "attribution_verified": false,
  "unique_counts_verified": false,
  "guardrails_ok": true,
  "weekday_weekend_represented": false,
  "variants": {
    "A": { "exposed": null, "clicks": null, "donors": null, "net_cents": null },
    "B": { "exposed": null, "clicks": null, "donors": null, "net_cents": null },
    "C": { "exposed": null, "clicks": null, "donors": null, "net_cents": null }
  }
}
```

Run `node scripts/review_donation_experiment.js <aggregate-review.json>`.
The command validates counts, calculates a two-sided Fisher exact p-value,
applies all three-comparison/four-look stopping criteria, and prints a decision and next review
timestamp calculated from the actual launch. It refuses invalid denominators,
never chooses a winner on clicks and returns inconclusive after day 42 when
criteria remain unmet. A guardrail failure stops the experiment immediately.
Only formal day 7/14/28/42 reviews can choose a winner that beats both other variants; other runs
are health checks. Rollout still requires evaluating revenue and usability.

## Validation

Run with Node 24 (Worker tests use built-in SQLite):

```
node scripts/test_donation_goal.js
node scripts/e2e_donation_experiment.js
```

The browser check requires Playwright and installed Chromium/Edge. `EDGE_PATH`
can override the browser binary; `NODE_PATH` can point to bundled packages.
`DONATION_SCREENSHOT_DIR` optionally saves desktop/mobile screenshots outside
the site. All external service requests in these tests are intercepted.
SQL/signature tests cover real SQLite aggregation, duplicate deliveries,
imported-opening-payment refunds, refund-before-create, UTC month boundaries,
activation gates and a known Fisher exact result. Browser checks cover A/B/C,
fractional-dollar totals, blocked storage, consent changes, mobile widths,
stale/malformed data and a request timeout.

Activation checklist:
- Approved targets: B=$50 and C=$100, October 7, 2026. A retains the existing appeal.
- Verified ledger month, sum, reconciliation timestamp: TBD.
- Attribution join mechanism/verification: TBD.
- GA custom dimensions: TBD.
- Live deployment date: TBD.

## Draft release wording — approval pending

Appeal: “Help keep Read-Aloud free. Your support helps cover the cost of
running the service.” Button: “Support Read-Aloud.” The display identifies
the verified one-time USD scope and refunds.

Latest updates: “We’re testing a clearer way to support Read-Aloud. Some
visitors may see a monthly contribution goal; the tool remains free.”

The wording has been submitted for owner approval. Do not insert/publish
the Latest updates entry until approved under CLAUDE.md. The existing A
appeal also needs review of its “no tracking” claim before a live launch,
given the current cookieless analytics configuration.

## Live site and payment-flow inspection

October 7, 2026 — Inspected the rendered live homepage at
https://read-aloud.com/ and its existing support link. The slim cream/red
support strip sits below the navigation and above the reading tool. The
current homepage shows the original appeal without monthly progress.
The link https://coff.ee/readaloud resolves to the creator profile
https://buymeacoffee.com/readaloud, which links back to Read-aloud.com.
All three variants retain this existing payment destination. The $50/$100
figures are monthly fundraising targets; visitors select their own gift amount
on BMC. No checkout or payment was submitted during inspection.

The public support page offers optional monthly gifts and a membership.
These are outside the current one-time-USD meter's scope and require separate
reconciliation before inclusion. Public supporter counts and messages are not
a source of verified current-month dollar totals. The inspected public BMC
session is signed out; the payment ledger, dashboard webhook configuration,
account receipts and completed-donation attribution remain unverified.

## Decision log
2026-10-07 — Owner selected $50 and $100 targets in addition to the original
appeal. Updated allocation to equal thirds, the API and analytics variants,
the ledger and review input to include C, and early-stop correction to twelve
tests (three comparisons across four formal looks). A winner must beat both
other variants; no deployment or fabricated donation totals.

2026-10-07 — staged implementation and conservative stopping rules.
No public fundraiser progress or experiment exposure has been claimed.

2026-10-07 — Hardened the draft with individual-payment opening ledger,
explicit activation/attribution gates, UTC month verification, automatic
six-week cutoff, consent updates, a four-second fetch timeout, a reproducible
review command and passing SQLite/signature/browser checks. Existing reader
lifecycle, speech segments, diagnostics and browser playback checks also passed.
Created six weekly follow-ups in the current Codex thread. Deployment
still requires actual goal, signing secret, D1 ledger, attribution and approved
release wording; mock fixture amounts are never public production values.

2026-10-07 — Basic isolated checks: the client preserved A, rendered B when a
verified goal response was supplied, and left the page unassigned when the
feed was disabled. The Worker returned ready:false while unverified and an
aggregate response with a mock database when verified. These are MOCK checks,
not a live webhook/payment or browser end-to-end test.
