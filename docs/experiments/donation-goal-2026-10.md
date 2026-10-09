# Monthly support goal test — operating record

**Status: homepage DEPLOYED, Worker deploy pending (October 8, 2026).** Every external
dependency has been removed: the Worker counts exposures and clicks itself, and the two
goal arms run in target-only mode without a reconciled ledger. Donation-level attribution
is impossible at Buy Me a Coffee and is NOT claimed. The experiment starts the moment the
Worker is deployed - see "Launch record". Kill switch: set EXPERIMENT_ENABLED = "false" in
worker/donation-goal/wrangler.toml and redeploy; everyone immediately sees appeal A.
Experiment: support_goal_2026_10. Owner: Read-Aloud operator.
Source: donation-experiment.js, donation-experiment.css, worker/donation-goal/,
index.html. This file is the permanent experiment record; do not rely on chat context.

## Design
- A: existing support-strip wording and existing Buy Me a Coffee link.
- B: same position, verified USD month-to-date progress toward a $50 goal.
- C: same position, verified USD month-to-date progress toward a $100 goal.
- Equal 1/3 random assignment across A/B/C. It persists for a tab session; only consenting
  visitors also retain the assignment in localStorage across visits.
- Fail closed: if the goal API is unavailable, malformed or stale, EVERYONE sees the
  original appeal, no enrollment or experiment tracking occurs.
- Two display modes for B/C. With a reconciled ledger month the strip shows real
  month-to-date progress toward the target. Without one it states the target only
  ("Monthly goal: $50 - October 2026") and shows NO raised figure and no progress bar.
  A missing ledger therefore delays the progress meter, not the experiment. No amount
  is ever guessed, and `totals_verified` in the API response says which mode is live.
- Enrollment also requires an explicit launch timestamp, experiment enable
  switch and verified attribution switch. It ends automatically at day 42.
- A verified winner can be rolled out at any formal review. The winner switch
  stops random assignment and takes priority over previously saved variants;
  it continues beyond the experiment's 42-day limit. Rollout view/click events
  use separate names so they cannot contaminate experimental results.
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
- [ ] Owner launches with the two commands in "Launch record" and reviews the deployed
      copy under "Draft release wording" below. The Latest updates entry has NOT been
      published; any copy change needs a homepage deploy.
- [x] Owner selected two fundraising targets, $50 and $100, on October 7, 2026.
      Do not claim either is an exact expense amount or invent separate balances.
- [x] Wording/privacy checked. The control strip's "No ads, no tracking" claim was FALSE
      (AdSense and GA4 both run on the homepage) and was removed on October 8, 2026; the
      control now reads "Free for everyone - there's just a server bill...". privacy.html
      documents the experiment, the own-server counters and the two goal display modes.
- [x] Create Cloudflare D1 database, initialize schema and deploy disabled Worker.
- [ ] Connect signed BMC webhook and verify deliveries; see below. NOT a launch blocker
      any more - it only switches B/C from target-only to a progress meter.
- [ ] Reconcile this month's successful USD one-time gifts and refunds to
      a known cutoff before showing a progress meter. Audit after each refund.
- [x] RESOLVED as impossible, October 8, 2026. Every field in BMC's published webhook
      schema was enumerated from
      https://cdn.buymeacoffee.com/assets/integrations/bmc-webhooks-openapi.json:
      DonationData carries id, object, transaction_id, status, refunded, amount,
      coffee_count, coffee_price, currency, total_amount_charged, application_fee,
      support_type, message, created_at, refunded_at plus supporter fields. There is NO
      referrer, source, campaign or UTM field, so a payment cannot be joined to a variant.
      Donation-level results are therefore reported as NA, permanently, unless BMC adds
      such a field. A click is intent, not revenue - see Metrics.
- [x] Replaced by the experiment's own counters, October 8, 2026. GA4 event-scoped custom
      dimensions are not retroactive and need console access, and ad blockers drop gtag
      outright, so GA4 could not be the measurement of record. The page now also POSTs
      each exposure/click to the Worker's /event endpoint, which keeps one aggregate row
      per day/variant/event in D1. The gtag events still fire; register the two custom
      dimensions in GA4 any time for a second, partial read.
- [x] Automated QA green on October 8, 2026: scripts/test_donation_goal.js and
      scripts/e2e_donation_experiment.js (control/$50/$100, target-only mode, winner
      rollout, random allocation, blocked storage, consent changes, 320/375/768px,
      stale/malformed payloads, 4s timeout, own-counter beacons), plus the existing
      reader lifecycle, speech segment, playback diagnostics and feedback suites.
      A real donation and refund still need to be observed once the webhook is connected.
- [ ] Record the LIVE launch timestamp under "Launch record" and populate the ledger
      table at each formal look.

## Verified live-goal setup
1. D1 `read-aloud-donations` is provisioned and bound in wrangler.toml:
   `730bedf9-04b2-499c-a792-f80a965ec6d4`. Reuse it; do not create a second ledger.
2. Schema has been initialized remotely with `schema.sql`. The initial empty
   database is not a verified opening balance; no donation data has been imported.
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

### Applying an early winner
After recording a valid decision from the review command and reviewing revenue
and guardrails, set `SUPPORT_ROLLOUT_VARIANT` to the selected `A`, `B` or `C`
and `EXPERIMENT_ENABLED=false` in `worker/donation-goal/wrangler.toml`, then
redeploy the Worker. Confirm `/goal` returns `experiment_active:false` and
the chosen `rollout_variant`, and check all visitors see that appeal regardless
of a previously saved assignment. This does not require a homepage deployment
or waiting until day 42. Keep the current-month ledger verified for B/C;
stale/unverified totals still fall back to the original appeal.

Monitor `donation_support_view` and `donation_support_click` for 14 days after
rollout; those events carry the same experiment/variant dimensions but must not
be included in the A/B/C test's exposure/click counts. The winner switch is an
operator action after a verified review; the site does not invent a winner or
fetch private analytics automatically. Leave it blank during the trial. To
restore the original appeal immediately, disable the experiment and set it to A.

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
**Primary outcome (the one that decides this test): support-link click rate**, measured
as /event `click` counts divided by /event `view` counts, per variant. Numerator and
denominator come from the same event stream under equal 1/3 random allocation, so the
comparison is like-for-like. Repeat visits make these events non-independent, which makes
the Fisher p-value anti-conservative; the Bonferroni threshold plus a required 20% minimum
lift and a 30-click-per-arm floor stand in for that. A click is measured intent to support,
NOT revenue - before any rollout, check that the account's monthly total did not fall.

Secondary outcome, available ONLY if BMC ever exposes a completed-payment -> variant join:
unique completed donors per unique exposed user. Count a donor once in each arm; multiple
payments are not independent conversions. Report net USD per 1,000 unique exposed users
separately for A, B and C. A Fisher test of donor conversion does not establish
statistical significance for revenue. A verified donation winner outranks the click result.
Buy Me a Coffee documents a GA4 integration for page traffic, but its setup guide
does not promise completed-payment events or variant attribution. Connecting GA4
alone does not resolve that requirement: validate an actual completed-payment join.
Reference: [official GA4 setup guide](https://help.buymeacoffee.com/en/articles/3446099-how-do-i-add-google-analytics-to-buy-me-a-coffee).
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

**Attribution blocker, now closed as impossible:** The BMC webhook total is the aggregate
of ALL eligible account donations, regardless of site variant or outside source, and the
published webhook schema has no referrer/source/campaign/UTM field (every field enumerated
in the pre-launch checklist above). No payment can be joined to a variant. The donation
result is therefore permanently NA for this test, and the decision runs on click rate.
Do not re-litigate this without a new BMC field or a different payment processor.

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
For an early CLICK-RATE winner on a formal look (the live decision rule), require all of:
- At least 30 click events IN EACH arm.
- The candidate beats BOTH other variants by at least 20% in click rate.
- Two-sided Fisher exact p < 0.05/12 (approximately 0.004167) for BOTH candidate
  comparisons, with no material guardrail regressions.
- Both weekday/weekend traffic represented.
- The account's month-to-date donation total has not fallen versus the prior period.
  This is a sanity check on the click metric, not an attributed measurement.

For an early DONATION winner on a formal look (only if BMC attribution ever exists):
- Verified per-variant completed payment attribution and comparable
  unique exposure denominators.
- At least 15 unique completed donors IN EACH arm.
- The candidate beats BOTH other variants by at least 20% in donation conversion.
- Two-sided Fisher exact test p < 0.05/12 (approximately 0.004167) for BOTH
  candidate comparisons: four planned looks times three pairwise comparisons,
  with Bonferroni adjustment and no material guardrail regressions.
- Both weekday/weekend traffic represented.

If criteria are unmet: continue to next scheduled checkpoint; don't
stop on a partial look or an exciting graph. At 42 days declare inconclusive
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
  "launch_at": "THE EXPERIMENT_LAUNCH_UTC VALUE ACTUALLY DEPLOYED",
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

Pull the counts straight from the experiment's own counters (operator machine, Cloudflare
login required). `exposed` is the `view` count and `clicks` is the `click` count per variant:

```powershell
cd C:/Users/ndaly/read-aloud-work/worker/donation-goal
npx wrangler d1 execute read-aloud-donations --remote --command "SELECT variant, event, SUM(count) AS n FROM experiment_events GROUP BY variant, event ORDER BY variant, event"
```

Use `rollout_view`/`rollout_click` rows only for post-rollout monitoring; never mix them
into the A/B/C counts. Leave `donors` and `net_cents` null - BMC cannot attribute payments.

Run `node scripts/review_donation_experiment.js <aggregate-review.json>`.
The command validates counts, calculates two-sided Fisher exact p-values for clicks and
(when supplied) donations, applies all three-comparison/four-look stopping criteria, and
prints a decision and next review timestamp calculated from the actual launch. It refuses
invalid denominators, refuses click counts that exceed exposure counts, reports
`click_rate_winner` only at a formal look under every criterion above, prefers a verified
`donation_conversion_winner` when attribution exists, and returns inconclusive after
day 42 when criteria remain unmet. A guardrail failure stops the experiment immediately.
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
- Verified ledger month, sum, reconciliation timestamp: NONE. B/C run in target-only mode.
- Attribution join mechanism: NONE AND IMPOSSIBLE (BMC schema has no source field).
- Measurement of record: Worker /event aggregate counters in D1 `experiment_events`.
  GA4 dimensions optional and unregistered.
- Live deployment date: homepage October 8, 2026; Worker PENDING (see Launch record).

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

## Backend deployment record

October 7, 2026 — Cloudflare CLI authentication confirmed the same account used
by Read-Aloud's feedback Worker. Created D1 `read-aloud-donations`, initialized
the schema and deployed `read-aloud-donation-goal` with all verification and
experiment enable switches false. Worker version:
`14427830-ca85-4e06-9515-531cf1cf0393`.

Verified live `GET /goal` returns HTTP 200 with `{"ready":false}`, `no-store`
and the expected allowed Read-Aloud origin; OPTIONS returns 204 with GET/OPTIONS.
Remote D1 query confirmed zero payment rows. That means no payment facts have
been imported, not that this month's donations are zero. BMC signing secret,
webhook delivery, opening ledger and completed-payment attribution remain pending.
No homepage deployment or launch timestamp was set. BMC is signed out in both
inspected browser sessions; a login tab was opened for the owner to continue.

## Launch record

Launch timestamp: `EXPERIMENT_LAUNCH_UTC = "2026-10-08T22:45:00Z"` is configured and
PR #51 is merged, so the homepage is deployed. **The experiment is not running until the
Worker is deployed.** Until then every visitor sees appeal A, because the client requires
the new `totals_verified` field that only the new Worker returns.

Remaining step, one command:

```powershell
cd C:/Users/ndaly/read-aloud-work/worker/donation-goal
npx wrangler deploy
```

No separate database migration is needed: the first `/event` write creates the
`experiment_events` counter table if it is missing, then retries. `schema.sql` stays the
canonical definition and the two must be kept identical.

Then confirm
`curl https://read-aloud-donation-goal.ndaly111.workers.dev/goal -H "Origin: https://read-aloud.com"`
returns `"ready":true`, `"experiment_active":true`, `"totals_verified":false` and
`"raised_cents":null`; load the homepage a few times to see all three appeals; and check the
counters move:

```powershell
npx wrangler d1 execute read-aloud-donations --remote --command "SELECT variant, event, SUM(count) AS n FROM experiment_events GROUP BY variant, event"
```

Record the real deploy time here and in the Ledger table if it differs materially from
the configured launch timestamp; formal looks are measured from the deploy.

Optional and independent of launch: install the BMC webhook secret and reconcile an
opening ledger (steps 3-8 of "Verified live-goal setup") to upgrade B/C from
target-only to a live progress meter. The experiment does not wait for it.

## Decision log
2026-10-08 — Removed every blocker that could not be cleared. (1) BMC's published
webhook schema was enumerated field by field: there is no referrer/source/campaign/UTM
field, so the "validate completed-payment attribution" prerequisite was unsatisfiable and
the test would never have launched. Donation results are now permanently NA and the PRIMARY
metric is support-click rate. (2) GA4 event-scoped custom dimensions are not retroactive,
need console access and are dropped by ad blockers, so the Worker now counts its own
aggregate exposures and clicks in D1 `experiment_events` — no console task, no lost
data, no identifiers. (3) B/C no longer need a reconciled ledger to run: without one they
state the target amount only and publish no raised figure, so the webhook/ledger work
upgrades the display later instead of blocking the launch. (4) The control strip's
"No ads, no tracking" claim was false — AdSense and GA4 both run on the homepage — and
was removed; privacy.html documents the counters and both goal display modes. Full unit,
SQLite, signature, browser and existing reader suites pass. Launch remains an owner action
(the two commands above).

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
