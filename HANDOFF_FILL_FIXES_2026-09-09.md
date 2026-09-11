# Handoff — IRIS autofill fixes (2026-09-09)

Repo `tax-rocket-new`, baseline commit `9a79d72` (branch `main`). **Nothing is committed** —
the changes are in the working tree, so a workspace download carries them. Companion docs:
`FBR_FILL_PHASES_2026-09-09.md` (what and why, per phase), `ELECTRON_FILL_ANALYSIS_2026-09-09.md`
(the original analysis, with its two retracted claims marked at the top).

## What is in this bundle

Runtime code (7 files):

| File | What changed |
|---|---|
| `lib/tax/portal-row-evidence.ts` | **NEW, generated.** Census of every IRIS row id ever captured (`writeableInputIndexes`, `captureCount`). It is the only thing that decides what the agent may auto-fill — see Phase 7 in `FBR_FILL_PHASES_2026-09-09.md` |
| `lib/tax/portal-field-map.ts` | **capture-evidence gate (Phase 7):** a code is queued only if a capture proved an enterable row for it; everything else moves to `mappingGaps.captureUnverified` (amount + reason) and stays manual. Before: 49 codes could be queued on 6 provable rows |
| `lib/tax/portal-field-map.ts` | `version 1.1.0`: one field per IRIS cell (aggregated by `irisCode:column`), targets the **entered** column instead of IRIS's derived normal-tax column, skips `rowLevel:"Summary"` codes, reports `mappingGaps`, no silent `5028` fallback |
| `lib/tax/iris-field-codes.ts` | `CATEGORY_TO_IRIS_MAP` reduced to categories whose IRIS line has been **seen rendered**; `PENSION` no longer double-writes `1008` + `5007`; unverified categories are gaps, not guesses |
| `electron-connect/iris-row-filler.js` | grid-aware header resolution; `no_editable_cell` + `hint:"computed_row"` for fully-derived rows; `unverified_target` (live refuses a cell reached only by position); `readback_mismatch` (a write the portal reverted is never `filled`); `normalisePortalAmount` (whole-rupee digits only); `BUILD_TAG` |
| `electron-connect/main.js` | `TAXROCKET_REAL_AUTOFILL` resolution + `livePilot.automaticFilingEnabled` kill switch; live mode refuses sections the tour could not verify; readiness = return workspace, not input count; drift is now evidence-based (`portal_mapping_review` / `portal_structure_review` instead of `selector_bundle_update`); autofill holds (`portal_state_confirmation`) when the return is not provable; failed + paused records carry `autofillSummary` + `portalEvidence`; build-stamp guard now covers the filler too |
| `electron-connect/iris-navigation.js` | exports `RETURN_WORKSPACE_PROBE` (proves `app-nitr-workflow` + tax year + 114(n)/116(n) + Registration No), `ROW_BEARING_SECTION_IDS`, `buildPortalEvidenceDiagnostics` |
| `lib/tax/fbr-agent-config.ts` | `#homeLink` semantics documented ("logged in", never "on the return"); `livePilot.automaticFilingEnabled` documented as a kill switch |
| `app/actions/packet.ts` | **Behaviour change to expect:** packet generation now REFUSES a draft whose income has no verified IRIS line (`mappingGaps.unmappedCategories` with a non-zero amount) instead of writing a salary-only snapshot. Also returns `mappingGaps` so the wizard can show it |
| `app/actions/packet.ts`, `components/tax/filing/filing-wizard.tsx`, `components/tax/filing/config/filing-wizard-config.ts`, `components/tax/filing/wizard-packet-step.tsx`, `lib/tax/filing-status.ts`, `app/tax/fbr-connect/page.tsx` | wizard FBR rail now completes on `FILING_COMPLETED`/`DRY_RUN_COMPLETED` via `isFbrAgentCompleted` (it compared against `"COMPLETED"`, which nothing writes → the step could never go green); standalone FBR page passes `taxPayable`/`refundDue`/`packetVersion` to the final gate and shows the agent status; "Manual entry still required" panel driven by `mappingGaps` |

Docs / tooling: `electron-connect/README.md` (env var finally documented), `scripts/replay-agent-autofill.cjs`,
`scripts/portal-coverage-inventory.cjs`, `scripts/verify-portal-field-map.cjs`, updated
`scripts/verify-iris-row-filler.cjs`, `scripts/verify-iris-navigation.cjs`,
`scripts/verify-ty2026-filer-status.cjs`, `package.json`.

## 1. Verify here first (offline, no IRIS, no DB for most)

```bash
npm install && (cd electron-connect && npm install)
npx playwright install chromium          # verify:iris-navigation needs it
npm run verify:all                       # 19 suites; expect exit 0. I ran 16 of them here (all
                                         # green: 27/27 filler, 100/100 navigation, 14/14 field map);
                                         # the 3 DB-backed ones below I could NOT run.
node_modules/.bin/tsc --noEmit -p tsconfig.json
npm run build
HOME=/path/to/your/captures npm run inventory:portal-coverage        # coverage + evidence census
HOME=/path/to/your/captures npm run inventory:portal-evidence          # REWRITES lib/tax/portal-row-evidence.ts
HOME=/path/to/your/captures npm run replay:agent-autofill -- --job "<userData>/TaxRocketAgentLogs/latest-job.json"
```

`verify:withholding-sources`, `verify:money-database`, `verify:bank-statement-isolation` (inside
`verify:all`) and `verify:ui*` need the Docker Postgres (`taxrocket-postgres`, 5432) — **not
runnable in my sandbox**, so they are unverified by me. My changes touch none of their code paths
except `app/actions/packet.ts`'s return value, which is what `verify:ui-wizard` would cover if you
have it green locally.

Expected on the replay, from my run against your captures: `writeable targets found by replay: 6`
against the recorded `0/27 filled` with `{"column_disabled":24,"row_not_found":3}`.

## 2. Local live test (in this order)

1. **Regenerate the packet.** An old packet still carries
   `column: "Amount Subject to Normal Tax"` and the new filler will (correctly) refuse every line.
   In the wizard: re-run calculation → generate packet → approve. The packet step must now show
   **"Manual entry still required"** listing exactly which sources the agent will not fill.
2. **Dry run** — `TAXROCKET_REAL_AUTOFILL=dry`, restart the agent, queue a dry-run job.
   Read `<userData>/TaxRocketAgentLogs/latest-job.json`:
   - `result.autofill.summary.byStatus` should show `filled` on the **salary** Total column rows,
   - `unverified_target` where a cell could only be guessed,
   - `no_editable_cell` with `hint:"computed_row"` for `1000`/`7019`/`703000`,
   - and the job must NOT be parked on `selector_bundle_update`.
3. **Live** — `TAXROCKET_REAL_AUTOFILL=live`. Expect writes **only** into sections where the tour
   reported `mappingVerified: true` (in your capture that was `salary` alone); the rest log
   `real_autofill_section_unverified`. If the return is closed/gate page, the job pauses with
   `portal_state_confirmation` instead of filling nothing and calling it done.
4. **Then** re-run the replay tool against the new `latest-job.json` — the fill count is the number
   to compare, and `latest-portal-inspection.json` is what I need if anything refuses unexpectedly.

## 1a. The TY2026 "Normal Return" popup: CONTINUE is now clicked

Old behaviour you reported: the dialog appeared, Tax Period already said 2026, and the agent just
sat there. It was never typing "2026" — IRIS prefills it (the probe never writes values) — and the
agent stopped because it could not recognise the caption ("Tax Period" vs the accepted
"Tax Year"/"Period"), the caption is a `<mat-label>` the selector did not read, and the dialog's own
Material backdrop blocked its Continue button. Now (build `fix17-setup-continue-20260910`) it
advances that dialog, and only that dialog: it still refuses when a box is empty, when the period
names a year other than the packet's, or when any password/OTP field is present. Save and Submit are
still never touched. In `latest-job.json`, look for `new_return_setup_stage` then
`new_return_setup_action: period: new-return-continue clicked`.

## 1c. CNIC: one upload, and the card wins on identity (Phases 9–10, new this pass)

Two changes, both in `lib/tax/cnic-profile.ts` (pure: the rules and the sentence you see are built by
the same function, so they cannot drift).

**Approving a CNIC writes the profile.** Date of birth always; legal name and CNIC number from the
card, **including over a name a Google/GitHub login supplied** — the note reports the replaced value
(`legal name (was Ali Raza Khan)`) instead of doing it quietly. Address is filled only when the
profile has none, because a printed card goes stale. A number another account already claims is
refused with an explanation, never a database error. Father name: not stored (no column, and you said
it is not needed). A card whose date of birth cannot be read is a refusal, not a guess.

**An expired card is refused.** The extractor now returns the card's printed "Valid Upto" date as
`Expiry Date`; if that date has passed, approving the CNIC gives an error and **nothing** is written —
"upload the renewed card from NADRA" — and the slot stays open. If a card prints no expiry date (older
laminated ones) the approval proceeds and the note says the validity could not be checked; that
asymmetry is deliberate, since inventing an expiry over a printing difference would block a valid
filing. Fix a misread date in the review panel and approve again.

**The same card is not uploaded again next year.** `carryForwardIdentityDocumentsAction` copies the
newest earlier *approved* CNIC onto the new draft before the documents step renders, so the slot
arrives filled and the packet gate sees it. It copies only when the profile still carries both the
CNIC and the date of birth that approval wrote, **and only while that card has not lapsed** — a card
approved for last year and expired since is refused with the date named ("…expired on 31 January 2026,
so it cannot be reused for this filing"). And only for `cnic`: salary certificates and bank statements
are per-year by nature, so carrying them forward would file last year's income as this year's. If
reuse is not possible the slot stays open and says why.

`verify:cnic-profile-plan` (22 tests, 162 assertions) is part of `verify:all`. It runs the real
planner and the real reuse decision; the DB calls and the React wiring are asserted statically.
Mutation-checked: widening the allowlist, dropping the verified-profile guard, reverting the name
rule, dropping `MAPPED` from the source query, dropping the owner filter and hiding overwrites each
failed the suite on its own — including all six validity mutations (unread→expired, writing from an
expired card, no refusal in the action, reuse ignoring a lapsed card, exclusive expiry day,
month-first parsing).

Two pre-existing bugs fixed here: "father name" could satisfy the "name" label lookup, and the stored
CNIC lacked the dashes the profile form requires.

What to watch on your run: (1) approve an upload and read the note — the fields it lists must match
what the profile page shows afterwards; (2) open a *second* tax year draft with no upload and confirm
the CNIC slot is already marked approved and names the year it came from; (3) if you deliberately
clear the profile's date of birth, the slot must come back asking for the card; (4) approve a card
whose printed expiry is in the past and confirm the red error names the date and writes nothing.
Needs `GEMINI_API_KEY` on your machine or the extraction says it is not configured.

## 1b. Expect a SMALLER packet now — that is the point

After Phase 7 a salary-only packet has **1** write target (`1009`), not 27 fields. If your live dry
run reports e.g. `filled 1, skipped 0`, that is success under the current evidence: 42 of the 49
codes had never been seen rendered, and the previous `0/27 · 24 × column_disabled` run was that
phantom coverage showing up as failures. `verify:all` and the build stay green; the numbers in the
replay (`writeable targets found by replay: 6`) and the map (`evidence: 6 … targeted`) now agree.

## 1d. Want data actually written into IRIS columns? This is the whole checklist

Four things, in this order — the operator's last run failed on #1 and #2 simultaneously, which is why
it reported `0/27 filled; 24 column_disabled, 3 row_not_found` on build `fix16-new-return-setup-20260908`.

1. **Fresh packet.** Regenerate and re-approve. Anything built before P0 still says
   `column: "Amount Subject to Normal Tax"`, and that IRIS cell is derived and `disabled` — every
   field is refused before it starts. New packets target `column: "Total Amount"`
   (`lib/tax/portal-field-map.ts:219`).
2. **Deployment key** — web app environment, i.e. the `.env` Next.js reads:
   `TAXROCKET_ALLOW_LIVE_FILING="true"`. Then restart the dev server. Without it the agent downgrades
   `live` to a dry run and says so in the job log.
3. **Operator key** — in the *agent's* shell, never the web `.env` (`electron-connect` reads no
   `.env` file): `TAXROCKET_REAL_AUTOFILL=live npm run dev`. `dry` is still the right first call for a
   new machine: it proves which cell each amount would land in, without touching anything.
4. **What is provable on screen at that moment.** Headings must be exactly the four expected; row
   `1009` must expose cells 0 and 2 editable with 1 and 3 disabled; row `1000` fully disabled
   (`iris-navigation.js:1053-1090`). Any mismatch → refusal, and that is correct.

Expect, honestly: **one salary row filled, everything else reported as manual.** That is not a
half-done fix — rent, capital gain, other income, §149 and the wealth statement are sections whose
rendered structure was never captured, so there is nothing to verify their columns against. Unlocking
them needs the five captures listed in §3, not a code flag.

Rollback in one step: unset `TAXROCKET_ALLOW_LIVE_FILING`, restart the web app. The panel stops
showing the live alert, and the same agent process reverts to dry behaviour on its own.

## 1e. "Packet not generated: … has no verified IRIS line item" — what to do

That red box is the P3.2 gate working, not a broken wizard: the engine priced income that no verified
IRIS line can carry, so generating a packet would produce a return that quietly omits it.

Two ways forward, and the wizard now offers the second one:

1. **Clean it up** — usually the fastest. A `test (100)` style row is a leftover from trying the app:
   delete that ledger entry / deselect that source. Interest and reconciliation-inflow amounts cannot
   be "cleaned" away; they are real, so use (2).
2. **Tick "Generate anyway — I will enter these in IRIS myself."** The packet is generated with those
   amounts recorded inside it as `coverage.mode = "partial_manual_entry_required"`, and the agent will
   not fill them. Enter them on the portal, then let the packet PDF be your worksheet.

Nothing else moves: approval, reconciliation and the FBR step behave as before, and the same
`mappingGaps` list the block used is still shown on this step. To turn the option off for a
deployment there is nothing to unset — the box only appears while a category is actually blocked.

## 2b. One gate added because of the P5 gap

`generateFilingPacketAction` now stops when an income category is priced by the engine but has
no verified IRIS line (business / services / capital gains / dividend / profit on debt / foreign).
Before this, that taxpayer got a **salary-only packet**, the agent filled it cleanly, and the
return would have quietly omitted income — `ESTIMATE` + ATL + reconciliation gates all passed
because they check money, not coverage. The refusal names the categories and amounts and points at
the two things that would clear it: the live capture (P5) or the engine-side route work in
`NEEDS_RULES_IMPLEMENTATION.md` §31. Locked by test 13 in `verify:portal-field-map`.

If you would rather let practitioners generate such packets (with the warning as the only
safeguard), that is a one-line change — but it should be your call, not a default.

## 3. Still blocked on you (P5)

`npm run inventory:portal-coverage` prints it precisely. Headline from your own captures:
**463 codes in the portal extract, 397 never rendered, 414 with no `IRIS_CODES` entry.** The five
captures that unlock real filers: Property receipts, Other Sources receipts, Capital Gain
(long/short), the Adjustable-Tax grid rows (151(b)/155/148/231AB/236C/236K), and a full
**116 Wealth Statement** set. Each must be a saved DOM (`IRIS 2.0 *.html`) with that section's
grids **expanded**, plus a fresh `latest-portal-inspection.json`.

Deliberately not done, because guessing would put a wrong figure in a return: mapping codes for
those areas, attachment file-upload automation (the three `doc_*` inputs are `hidden type=file`
and outside this filler's text-write model), and any payment/PSID step (`PSID`/`Generate` appear
0 times in all 13 captures).

## 4. If a test of mine is wrong

Three assertions were changed because they locked a bug, not a behaviour, and each says so inline:
`verify:ty2026-filer-status` asserted the wizard's `=== "COMPLETED"` check;
`verify:iris-row-filler` asserted `column_disabled` for whole-row derived rows;
the P3.4 hold sits in `runRealIrisAutofill` because `runLocalTaxAssistedFilingFlow`'s body is
unreachable in real-portal mode. If you disagree with any of them, that is the discussion to have —
not with the surrounding code.
