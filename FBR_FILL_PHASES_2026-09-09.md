# FBR Connect — data-fill phase plan (2026-09-09)

Driven by the operator's live logs (`TaxRocketAgentLogs/latest-job.json`,
`latest-portal-inspection.json`, job `cmttt19vj000mo8c80v6916tw`, build
`fix16-new-return-setup-20260908`) and the 13 IRIS 2.0 page captures +
`IRIS_System_Field_Codes_Extracted.csv`.

## 0. What the live log actually proved (and what my earlier read got wrong)

The real run is **much healthier than I assumed**. Correcting `ELECTRON_FILL_ANALYSIS_2026-09-09.md`:

| Earlier claim | Verdict from the live log |
|---|---|
| §S2 "`tax_deductions`/`allowance_credits` are not in the tour, so 149 (`64020004`) can never be placed" | **WRONG.** `INCOME_SECTION_IDS` = `salary, tax_deductions, allowance_credits, withholding, computations, payment, attachment` (derived at `iris-navigation.js:52-60`); the log shows all 7 captured, and `tax_deductions` captured `64020004, 64020005, 64020007, 64210051/54/56` with per-grid headers. Placement works. |
| §S3 "the 116 wealth panels are in the tour and block it" | **WRONG.** They are *excluded* from `INCOME_SECTION_IDS`, which is exactly why `1000`'s `row_not_found` no longer happens. The real wealth gap is the other way round (see P0.5). |
| §3 "`64151905` → `header_exact`, alias list incomplete" | **IMPRECISE.** `resolveColumnIntent("Tax Deducted")` → `tax_collected` (verified in node); the match is `header_partial`, not `header_exact`. Withholding/`tax_deductions` do resolve. |
| §4 "`PUBLIC_CODE_SET` is not the blocker" | Confirmed correct. |
| §M4 "salary c3 is disabled" | **CONFIRMED, and it is the whole failure.** |

**The single real failure in the live run:**

```
autofill: mode=dry  total=27  filled=0
  12 × 1000  column_disabled col=3 (header_exact)  section=salary
  12 × 1009  column_disabled col=3 (header_exact)  section=salary
   3 × 5028  row_not_found                          section=null
```

…while the agent's own fixture test asserts the correct behaviour
(`scripts/verify-iris-row-filler.cjs:121` — *"salary: writes into the editable Total column of
row #1009"*, and `:132` — *"'Subject to Normal Income' is IRIS-derived and must be refused"*).

So: **the filler is right; the packet builder is asking for the wrong column.** The capture layer
also already produces everything needed (per-grid `columns`, per-cell `column`/`disabled`/
`selectorUniqueInCapture`, per-section `mappingVerified`) — the fill path just ignores it.

## Phase 0 — packet builder targets the writable column — **DONE, verified**
Files: `lib/tax/portal-field-map.ts`, `lib/tax/iris-field-codes.ts`, new suite
`scripts/verify-portal-field-map.cjs` (`npm run verify:portal-field-map` → **11/11**), new
replay tool `scripts/replay-agent-autofill.cjs` (`npm run replay:agent-autofill`).

Every item 1–6 below is implemented as written; the two deltas from this plan are recorded
inline in the code comments: the column policy is expressed as *"the first editable column
that a header resolves to, preferring Total"* rather than a hardcoded per-category table
(the fixture captures show `1009`'s col 2 is also editable), and unverified categories are
absent from `CATEGORY_TO_IRIS_MAP` entirely instead of mapped-then-skipped.

1. **Aggregate by `(irisCode, column)`** instead of emitting one field per ledger row.
   Today 13 SALARY ledger rows → `1009` × 13, each later write overwriting the previous
   (log: 24 entries for 2 codes). Aggregation is the difference between a right number and a
   silently partial one.
2. **Column target by IRIS editability, not a constant.**
   - `Employment/Salary` line items (`1009,1049,1010,1059,1089,1099,1008`) → **Total column**
     (`"Total Amount"`); IRIS derives Final/Exemption/Normal and recomputes `1000`.
   - Final-tax routes (`BANK_PROFIT`, `DIVIDEND`) → **`Amount Exempt from Tax / Subject to Fixed /
     Final Tax`** (resolves to `Subject to Final Tax`). Not normal-tax — this is the M3 bug.
   - `Property` receipts (`2001`) → Total; the `1/5th` deduction (`2031`) → Total on its own row.
   - Wealth (`7012,7031…`) → `"Amount"` (single-column sections).
   - Tax credits → `"Tax Collected / Deducted"` (unchanged; resolves to `Tax Deducted` = col 1 of the
     2-col Adjustable-Tax grid, editable per live capture).
3. **Never emit an entry for an IRIS `Summary` row** (`rowLevel === "Summary"` in
   `IRIS_CODES`): `1000, 2000, 2029, 2099, 5000, 5029, 4000, 6000, 640000` are computed —
   the log wasted 12 refusals on `1000`.
4. **No silent `5028` fallback.** An unmapped category is recorded in
   `mappingGaps.unmappedCategories` and produces **no** autofill field (previously: 3 ×
   `5028 "Other Receipts"` → `row_not_found`). Business/other/services income has no verified
   IRIS line-item code — guessing one into a government return is worse than not filling it.
5. **Pension double-count fixed:** `CATEGORY_TO_IRIS_MAP.PENSION` wrote the same amount to `1008`
   *and* `5007`. Salary-side only; `5007` stays reachable via an explicit
   `PENSION_OTHER_SOURCES` category.
6. `buildPortalFieldMap.version` → `1.1.0` and `selectorBundle.version` bumped, so old packets and
   new packets are distinguishable in `packetHash`.

## Phase 1 — fill layer consumes the captured structure — **DONE, verified**
Files: `electron-connect/iris-row-filler.js`, `electron-connect/main.js`,
`scripts/verify-iris-row-filler.cjs` (now **27/27**, was 20/20 — 7 new tests cover items 2–4).

1 is done as specified, with one change found necessary by the live captures: the bar search
does **not** stop at a `dataRow` sibling (in `withholding.html` the heading bar and every row
are siblings of one container, so stopping at a row meant the bar was never found and the
header came back empty → `column_not_found`). Bars are ranked by sibling distance, nearest
first, and only the bar set whose label count matches the row's cell count is accepted — that
is what fixes `Tax Collected / Deducted` resolving against the *last* of 6 heading bars.

2 — implemented as `no_editable_cell` + `hint: "computed_row"`, **not** a new
`row_all_readonly` status: the row is refused before any column is chosen, so the existing
`column_disabled` name was reporting a lie (it claimed a per-column problem on a whole row).
`scripts/verify-iris-row-filler.cjs` assertions for `#1000`, `#7019`, `#703000` and the
summary counts were updated to the accurate status, and the reason is stated in each test.

3 — `unverified_target` blocks live writes whose cell was reached only by
`position_fallback`/`sole_editable`; `payload.allowUnverifiedTargets` (and the caller's own
`sectionVerified` gate in `main.js`) is the only way through. Dry runs still report the guess.

4 — `normalisePortalAmount()` runs in `prepareField` (digits-only whole rupees, half-up on
paisa, `1e+21` and `"1,000 rupees"` refused as `unparseable_amount`); post-write read-back
mismatch is `readback_mismatch` and uses `continue`, so one reverted cell cannot swallow the
rest of the section's results.

5 — the section gate is live: `runRealIrisAutofill` reads the tour's per-section
`mappingVerified` and refuses to write into an unverified section in `live` mode, logging
`real_autofill_section_unverified` per field group. Because 6 of 7 sections in the operator
capture were `mappingVerified:false`, this means **the next real gain must come from P5
(captures) or the tour's own header verification, not from removing this gate.**

1. Resolve the column from the **owning grid's** headers. Today
   `headerLabelsFor()` walks to the *last* `.heading-bar` in the parent, and each panel render also
   contains two depreciation sub-table headers (verified: `form3.html` → 3 heading bars,
   `withholding.html` → 6 grids). Use `row.closest("mat-expansion-panel")` / the nearest bar in both
   directions, and only accept the header set whose value-column count equals the wrapper count.
2. **`row_all_readonly` reason code**: a `[D D D D]` row is a derived IRIS row. Report it as
   `row_readonly` with the row description + candidate columns instead of `column_disabled` on
   whatever column happened to match first.
3. Refuse `position_fallback` and `sole_editable` for **live** writes; dry-run may still report them
   as `*unverified*` targets. Rationale: `923184` was "filled c0 (sole_editable)" in my simulation —
   a cell whose identity was never proven must not be written on a real return.
4. Money hygiene: value must be a plain integer-rupee string (`onkeypress` blocks `>57`, inputs carry
   a `thousandseparator` attribute, `String(1e21)` would have written `"1e+21"`); post-write readback
   must equal the requested value or the field is reported `readback_mismatch`.
5. Section trust gate: `main.js` passes the tour's per-section `mappingVerified` into
   `fillIrisRows(..., {sectionVerified})`; live mode refuses to write into a section the capture
   could not verify. In the log, 6 of 7 sections were `mappingVerified:false` — only `salary`
   was verified — so this gate matters immediately.

## Phase 2 — honest diagnostics — **DONE**
File: `electron-connect/main.js` (`buildMappingRefusalDiagnostics` + the new first branch of
`classifyRecoverableAssistedIssue`)

Implemented: when the execution log carries `real_autofill_skip` steps, the job is now parked
with `requiredAction: "portal_mapping_review"` and a `mappingRefusalDiagnostics` block
(refusal count, per-status counts, likely cause, recommended actions, up to 40 verbatim
refusals) instead of `selector_bundle_update`. That is precisely the live failure: 24 refusals
were misread as selector drift, and an operator was told to rewrite selectors.

Also done: `buildSelectorDriftDiagnostics` no longer decides by substring. It takes
`buildPortalEvidenceDiagnostics` output (per-section row/grid/mappingVerified counts, computed in
`iris-navigation.js` so main.js cannot grow a competing copy of the section rules) and reports
drift only when a row-bearing section rendered **zero rows**
(`selector_drift_confirmed_by_capture`); with an intact structure it returns `null` even when the
message says "selector". A `structure_unverified` capture produces a new `portal_structure_review`
action. `portalEvidence` + `autofillSummary` are written on BOTH the failed record and the
`awaiting_user_action` record (previously the counts existed only in `latest-job.json` on the
success path). Locked by 2 new tests, one replaying the operator's real capture shape
(7 sections, rows everywhere, 6 unverified → not drift).

1. ~~Stop classifying by `message.includes("selector")~~ → done, with `reasonCode`s
   `portal_mapping_refused`, `selector_drift_confirmed_by_capture`, `selector_drift_suspected`:
   (`fill_refused_column_disabled`, `fill_refused_unmapped`, `fill_section_not_opened`,
   `fill_structure_unverified`) and only raise `requiredAction: selector_bundle_update` when the
   capture itself shows row loss (a section tour with `rows: 0` or `structurePresent:false`), i.e.
   when evidence says the DOM changed rather than when a string matches.
2. `last-agent-job.json`'s pause (`selector_bundle_update` + dashboard DOM dump) was an inference
   from the string `"…target form was not detected as ready"`; keep it reachable but only for real
   drift, and always attach `autofill.summary` so the operator sees the counts.

## Phase 3 — readiness & resume robustness — **DONE (1–4)**
Files: `electron-connect/main.js`, `electron-connect/iris-navigation.js`,
`scripts/verify-iris-navigation.cjs` (now **88/88**, 1 new test), `lib/tax/fbr-agent-config.ts`

1 is implemented as specified, and the predicate is **shared, not duplicated**:
`RETURN_WORKSPACE_PROBE` lives in `iris-navigation.js` (next to the `classifyPage`
`readiness.returnWorkspace` logic it mirrors) and `navigateIris2DashboardFlow` now reports
`formReady` from it instead of `formOpen > 0`. Proof from the real captures, no simulation:

| capture | old predicate | new probe |
|---|---|---|
| `IRIS 2.0 blue tile.html` (economic-transactions gate) | `formReady: true` ← **false positive** | `returnWorkspace:false`, `reason:"app-nitr-workflow-absent"`, inputs 10 |
| `IRIS 2.0 form3.html` (return open) | true | `returnWorkspace:true`, evidence `year/returnDocument/registration` all true, inputs 171 |
| `IRIS 2.0 form 5.html`, `payment.html` | true | `returnWorkspace:true` (159 / 156 inputs) |

Two bugs the probe test caught that a jsdom-only check would have shipped: the script must
read `textContent` (`innerText` is undefined outside a browser, which made every label match a
false negative), and a zero-size `getBoundingClientRect()` must NOT count as hidden (a capture
whose stylesheets did not load would otherwise look like a closed form). Because the probe is
built from a template literal in `iris-navigation.js`, its regex backslashes must be doubled —
verified by evaluating the exported string in a real Chromium, not by reading it.

2 — the real-portal branch of `navigateToIrisForm` now **returns** instead of falling through to
the mock-era chain (`#iris-return-form-ready`, `#return-tax-form`, `a[href*='IncomeTaxReturn']` =
0 matches in 13 captures). The fall-through only burned per-selector timeouts and produced a
message containing "selector", which is how a readiness miss was labelled drift. The mock keeps
its chain; a static test locks the `formReady: false` early return.
3 — `#homeLink`'s semantics are stated at its only producer (`lib/tax/fbr-agent-config.ts`):
"logged in", never "on the return"; readiness is `RETURN_WORKSPACE_PROBE`.
4 — re-entry is asserted, not assumed: `runRealIrisAutofill` runs `RETURN_WORKSPACE_PROBE` before
the first `navigateToSection` and, if the workspace is not provable, returns
`paused:true / portal_state_confirmation` with counts of `0 filled`. The assisted flow turns that
into `awaiting_user_action` (it used to be swallowed into a "completed" job that filled nothing).
This deliberately sits in the autofill path, not in `runLocalTaxAssistedFilingFlow`'s body — in
real-portal mode that body is unreachable (the function returns early), which is exactly why the
old `loadURL(dashboardUrl)` re-entry path never verified anything.

1. `formReady` must not be "any visible input" (`main.js:790-812`): the Summary-of-Economic-
   Transactions gate renders 10 visible inputs, so the gate can satisfy it. Use the existing
   `returnWorkspace` evidence (`app-nitr-workflow` + `app-wf-header` + `Year 20xx` + `114(n)/116(n)`
   + `Registration No:`) as the readiness proof.
2. Drop the mock-era `routeSelector` chain for real IRIS (`#iris-return-form-ready`,
   `#return-tax-form`, `a[href*='IncomeTaxReturn']` → 0 matches across all 13 captures), or keep it
   but never let its failure be reported as selector drift.
3. `#homeLink` (the real `readySelector` default) exists on every return page, not just the
   dashboard — fine as "logged in", must not be treated as "on the return".
4. Resume: `loadURL(dashboardUrl)` on `phase==="start"` re-enters by draft-row dbl-click
   (`main.js:4190/4208`); assert identity + section state after re-entry instead of re-running the
   whole tour blindly.

## Phase 4 — operator surface — **DONE (1–4)**

1 — `TAXROCKET_REAL_AUTOFILL` is now documented in `electron-connect/README.md` (semantics of
`off|dry|live`, the two safety rails, and the "0 fields filled is not a success" warning), and
`live` is accepted as a value alongside `1/true/on` so the documented word matches the code.
`real_autofill_start` already echoes the mode in every job log.
3 — `iris-row-filler.js` now carries `BUILD_TAG` and `assertNavigatorBuild` compares **both**
`iris-navigation.js` and `iris-row-filler.js` against `AGENT_BUILD_TAG`, naming the stale file in
the error. `preload.js` was deliberately left out: it is a pure contextBridge with no portal
knowledge, and stamping it would add a failure mode (another file to keep in sync) without adding
a check that can catch a wrong write.
2 — `livePilot.automaticFilingEnabled` now means something: `resolveAutofillMode(jobContext)`
downgrades `live` → `dry` when the job config says `automaticFilingEnabled: false`, logs why, and
never lets `true` enable writes by itself (absent/null leaves the env var authoritative, so the
mock path and older bundles are unaffected). Kill-switch semantics were chosen because the shipped
default is `false`; wiring it as an *enabler* would have made `TAXROCKET_REAL_AUTOFILL=live`
unreachable for every existing deployment.
4 — `portalFieldMap.mappingGaps` now rides from the snapshot to the approval screen: both
`generateFilingPacketAction` and `getLatestFilingPacketAction` return it, `FilingPacketSummary`
carries a structural `PortalMappingGaps` type, and `wizard-packet-step.tsx` renders a
"Manual entry still required" panel (unmapped categories with amounts, deliberately-skipped
computed rows, pension split disagreements).

## Phase 4 — original checklist (kept for reference)
1. ~~`TAXROCKET_REAL_AUTOFILL` is in no README/.env~~ → documented in `electron-connect/README.md`.
2. `livePilot.automaticFilingEnabled` (`fbr-agent-config.ts:126,304`) is read by nothing → either
   wire it to the same gate or delete it.
3. Build-tag guard covers `main.js` + `iris-navigation.js` only (`main.js:71-77`) — add
   `iris-row-filler.js` and `preload.js` to the stamp so a partial file swap cannot run.
4. Show `mappingGaps.unmappedCategories` on the packet/approval screen (P0.4 data) so the
   practitioner sees "business income has no verified IRIS line — manual entry required".

## Phase 5 — coverage, in the order that unblocks real filers (P5, needs captures)
1. **Wealth statement (116)**: `buildPortalFieldMap` returns `wealthFields: []` by design, yet the
   app gates filing on wealth reconciliation. Live capture proves 116 is reachable
   (`7012[1×E]`, reconciliation `703002,7031,7032,7033,7088` editable; `7019,7021,7029,703001,703003,7049,7099,703000`
   derived → must stay refused). Needs its own phase/document, not a 114 panel.
2. Missing sheets for codes the packet can emit today: Property (2001/2031/2099),
   Other Sources (500312/5007/5028), Capital Gain (4000/4006/4016/4017/4026/4036/4037),
   Adjustable-Tax detail rows (64040002, 64080001, 64150301, 64151101), Payment tab (0 rows captured).
   Coverage today: agent knows 49 of the CSV's 463 codes.
3. `640000` must never be a target (it is the disabled Adjustable-Tax summary row).
4. Client rulings needed before Business/Services are attempted: which 3xxx line-item is the engine
   total for, and does 7E (`923183`) exist on `114(1)` at all.
   **Until those rulings + captures exist, the packet builder refuses the draft**:
   `generateFilingPacketAction` returns an error when `mappingGaps.unmappedCategories` holds a
   non-zero amount, so a business/services/capital-gains taxpayer cannot generate — and therefore
   cannot file — a salary-only packet. This closes the gap between "engine says ESTIMATE" (money is
   complete) and "portal map says gap" (the return would omit it), which no money gate could see.
   Test 13 of `verify:portal-field-map` locks both halves: salary-only → no block, business →
   exactly one gap carrying the amount, and the refusal sits before the snapshot is written.
   Reversible in one line if practitioners prefer warning-only.

## Phase 7 — capture-evidence gate (DONE 2026-09-10, "client CSV ko choro")

Asked and answered with measurements, not opinions:

| set | size | what it proves |
|---|---|---|
| client extract (`IRIS_System_Field_Codes_Extracted.csv`, TSV, code in `System_Code`) | 463 distinct / 536 lines | the code **exists somewhere** in IRIS |
| rows rendered in the 13 portal captures (`.tableRows dataRow[id]`) | 43 distinct | the row **appears on a real page** — of these 17 have ≥1 non-disabled `<input>`, 26 are read-only (incl. `1000`, `99990x` UI-shell rows) |
| `IRIS_CODES` (what the agent may write) | 49 | our **intent** |
| 49 ∩ 463 | **49** | we invented nothing |
| 49 ∩ 17 writeable | **6** | only 6 targets are actually provable today: `1008, 1009, 1049, 1089, 7012, 923184` |

**Change:** the packet map now queues a code only if it is in `PORTAL_WRITEABLE_CODES`, a census
generated from the captures (`lib/tax/portal-row-evidence.ts`, regenerate with
`npm run inventory:portal-evidence`). Everything else moves to
`mappingGaps.captureUnverified {code, description, category, amount, reason}`, which the packet
step renders as "IRIS rows we have never seen rendered". The `1000` case shows why a separate
bucket matters: it renders but with **both** inputs disabled, so it is not "unverified", it is
computed — and the two need different follow-up (capture the sheet vs. never write it).
Measured effect on a salary+rent+149-credit packet: `totalFields 1` (only `1009`), held
`2001/600000, 2031/120000, 64020004/150000`, skipped-computed `1000`. That is the honest state
of our evidence, and it is why the previous "0/27, 24 × column_disabled" run was never a selector
bug: 41 of 49 targets pointed at rows we have never seen.

`captureUnverified` deliberately does **not** block packet generation (unlike
`unmappedCategories`): the amounts still reach the packet/PDF as a worksheet, and the wizard tells
the operator what to key by hand. Tests 7, 8 and the new 14 in `verify:portal-field-map` pin it —
14 asserts incl. the census-vs-captures equality and a loop that fails if ANY packet for ANY
ledger shape queues an unproven code.

**Known routing risk, deliberately not changed here:** `SALARY` routes the whole ledger gross to
`1009` ("Pay, Wages or Other Remuneration") while `1049` Allowances / `1089` Perquisites are in the
map with no ledger category feeding them. For a payslip that is entirely allowances/perquisites,
`1009` is the wrong row. Fixing it needs a decision on the ledger side (split the payslip into
categories), so it is recorded rather than guessed — same class of problem as §31's per-route
expense gap.

## Phase 8 — the "Normal Return (Ind/AOP/COY)" dialog now gets past Continue (DONE 2026-09-10)

Operator report: the popup appeared, Tax Period already read 2026, and the agent never pressed
CONTINUE. Three independent recognition defects caused exactly that — none of them a policy about
Save/Submit, which remain untouched:

1. **Caption vocabulary.** `classifyNewReturnSetupStage` accepted `Tax Year` or `Period` before a
   `continue` action. IRIS renders **"Tax Period"**, so the stage was `null` →
   `requiredAction: portal_new_return_setup` (a Retry checkpoint). Now `tax period` is accepted in
   the module function *and* its serialized in-page mirror (the parity test keeps them identical).
2. **Caption selector.** The probe collected prompts from `label,legend,[role="heading"]`, but
   Material writes field captions as `<mat-label>` / `.mdc-floating-label` — never a bare `<label>`.
   One shared `SETUP_LABEL_SELECTOR` now feeds both prompt sources, so the dialog title and both
   captions are visible to the classifier.
3. **Its own backdrop blocked it.** The Phase 1.5a exemption required "no free-text input in the
   dialog". IRIS prefills Person (disabled) and Tax Period, and the dialog sits on a
   `.cdk-overlay-backdrop`; the exemption failed on the inputs, and `blocking` (backdrop) then
   refused the click inside the action path *and* in `probeFrames`' eligibility gate — the loop
   already tolerated `setupDialogOnly`, the two disagreed, so every retry deadlocked. The rule is
   now `setupFieldsAwaitHuman`: advance a recognised setup stage **only when every editable field is
   already filled and the 4-digit period equals the packet's tax year** (compared in-page; only the
   verdict leaves, never the value). `hasBlockingOverlay` keeps its conservative meaning so fill
   and readiness consumers are unaffected.

Deliberately still refused → `blocked_by_dialog` (and therefore a human checkpoint): an empty
editable box, a period naming another year (would open the wrong return), and any
`password`/`one-time-code` box even next to a recognised caption. `verificationSignature`
(OTP/captcha/PIN/PSID/payment), commit controls (submit/confirm/pay/i agree) and the residency
stage are untouched — residency remains the operator's declaration.

Evidence: 5 new tests in `verify:iris-navigation` run the real `portalProbe` in Chromium against a
structural copy of the screenshot — recognition, the CONTINUE click, and all three refusals.
**Suite is now 100/100** (was 95). Build tags moved to `fix17-setup-continue-20260910` in all
three `electron-connect/` files; an agent on `fix16` will still be refused by the startup guard, so
replace all four files together. Nothing typed into the dialog: `portalProbe` never writes values
(`grep -c "\.value =" electron-connect/iris-navigation.js` → 0 outside the row filler), so the
"2026" in that box has always come from IRIS itself.

No capture of this dialog exists in the 13 HTML files (`grep -l "Normal Return" uploads/*.html` → 0;
the only `id="2001"`/`id="7001"` hits are sidebar `<a>` links). This phase is therefore built on
the operator's screenshot + the DOM rules the captures *do* prove (Material overlay/label markup),
and the live dry run is the acceptance test for it.

## Phase 9 — an approved CNIC fills the profile, and the card wins on identity (DONE 2026-09-10)

Asked first: "father name ki zaroorat nahi, jo daal sakte ho daal do" — the card now supplies the
**legal name**, the **CNIC number**, the **date of birth** and the **printed address**.
Asked then: "cnic pr jo h wohi profile mn bhi ana chahiye na k google account se" — so on identity
fields **the card overrides what the profile already holds** (an earlier version filled only empty
fields and told the human to fix the rest by hand; that rule is retired). The card, not a login
provider, is the identity document.

Rules live in one pure module, `lib/tax/cnic-profile.ts` (`planCnicProfileUpdate`), because the
approval path is DB-bound and these decisions must be testable without Postgres:

| field | written | never |
|---|---|---|
| `dateOfBirth` | always from the card (§198/§149(IA) compute from it) | guessed — no printed DOB means the approval is refused |
| `name` | the card's printed name, **overriding a login-supplied one** | the profile already holds the same name (case/space-insensitive) |
| `cnic` | the card's number, **correcting a wrong one on file** | another account claims it (`User.cnic` is unique, FBR allows one account per number) |
| `address` | the profile has none | the profile has one — contact info, and cards go stale |

**Validity is checked first, and an expired card is an error, not a fill.** NADRA prints a
"Valid Upto" date; the extraction now returns it as its own `Expiry Date` field (asked for in the
prompt, read through `exactFieldValue` so "Date of Issue" cannot satisfy it — the DOB instruction that
says *never use the issue or expiry date* still stands). `readCnicValidity` returns three states:
`valid`, `expired` and `unread`.
- `expired` → the approval is **refused with no write at all**, before the date-of-birth complaint so
  the actionable error is the one shown: *"This CNIC expired on 12 March 2024. An expired card is not
  valid proof of identity, so nothing was saved from it — upload the renewed card from NADRA."* The
  document stays unmapped, so the slot stays open — and the operator can correct a misread date in the
  review panel (`updateDocumentExtractionAction`) and approve again.
- `valid` → no announcement; a check that passed is not news. The printed day itself is inclusive
  (a card ending 10/09/2026 is refused from 11/09/2026).
- `unread` → **accepted but disclosed** ("No expiry date was read from the card, so its validity could
  not be checked…"), because older laminated cards print no expiry at all and a two-digit year is not
  something to invent a century for. Guessing "expired" there would lock a taxpayer out of filing over
  a printing difference; that is the deliberate asymmetry.

The same check runs on **reuse**: a card that was valid for last year's filing and has since lapsed is
not copied into a new one — the slot comes back with *"CNIC number from your Tax Year 2025 filing
expired on 31 January 2026, so it cannot be reused for this filing. Upload the renewed card."* Payloads
saved before expiry was extracted have no expiry to read, so they still reuse (unchecked ≠ expired).

An override is **reported, never silent**: every replaced value lands in `plan.overwritten` and the
note names it (`legal name (was Ali Raza Khan)`). A refusal is also reported in words, not as a
database error.

Two defects fixed on the way:
1. `fieldValue` matched labels by substring, so **"father name" contains "name"** — the legal name was
   read by luck of field order. Identity fields now go through `exactFieldValue` (whole-label
   compare); the suite pins that call site.
2. The stored CNIC was **bare 13 digits**, while the profile form validates
   `^\d{5}-\d{7}-\d$` (`app/tax/profile/page.tsx:161`) — our own write made the next profile save
   fail. `formatCnicNumber` stores the dashed form; comparisons run on digits, and the agent side
   strips separators before matching the portal (it already did).

The wizard says what happened: `describeCnicProfilePlan` groups by *kind* — filled,
"Left as you had it", "Not read from the card" and a refusal sentence — in the documents step as
`role="status"` next to, not inside, the error block, cleared on any new upload/extract/review.
Father name is still extracted and still deliberately not stored: `User` has no such column and you
said it is not needed.

## Phase 10 — one CNIC upload covers every tax year (DONE 2026-09-10)

Asked: "cnic har bar upload na ho". Real defect: `getFilingDocumentsAction` scopes documents by
`filingDraftId`, and `cnic` is `required: true` in `CORE_DOCS`
(`lib/tax/document-requirements.ts:118`), so **each new draft opened an empty CNIC slot** even
though the person had already been verified.

Fix: `carryForwardIdentityDocumentsAction(draftId)` copies the newest earlier **`MAPPED`** CNIC row
(file + extraction payload + timestamps) onto the current draft. It is called from the wizard's
documents-load effect *before* `getFilingDocumentsAction`, so the step renders the slot as filled on
first paint and the packet gate sees it.

Why a copy and not a "satisfied by profile" flag on the slot: the evidence trail, the packet and the
review panel all refer to a `Document` row per filing, and readiness semantics are shared with the
bank-statement slot. Copying keeps every consumer honest; a synthetic exemption would have needed the
gate, the wizard and the packet builder to each learn a new rule.

`CARRY_FORWARD_DOCUMENT_TYPES` is `["cnic"]` — an allowlist on purpose. A salary certificate or a
bank statement is *for a year*; silently reusing last year's would file last year's income as this
year's.

Three guards, each pinned by a test:
- the source must be `extractionStatus: "MAPPED"` — a file someone uploaded and never approved is
  not a verification;
- the source belongs to `draft.userId` and to a **different** draft (`filingDraftId: { not: draft.id }`);
- reuse only when the profile still carries **both** `cnic` and `dateOfBirth`, i.e. the identity that
  approval wrote is still on file. Otherwise the slot stays open and the note says why
  ("upload it once and it will carry forward to future years").
- Any failure returns `success: false` and the ordinary upload path runs: reuse is an optimisation,
  never a blocker for the filing.

`scripts/verify-cnic-profile-plan.cjs` (22 tests, 162 assertions) exercises the real planner, the
real formatter and the real reuse decision, and asserts the wiring statically (per-query blocks in
the action, call order in the wizard, status-not-alert rendering). Mutation-checked and caught:
widening the allowlist to salary certificates, dropping the profile-verified guard, reverting the
name to fill-only-when-empty, dropping `MAPPED` from the source query, dropping the owner filter,
not recording overwrites — and for validity: treating "no expiry printed" as expired, letting an
expired card write the profile, removing the refusal from the action, letting the carry-forward
ignore a lapsed card, making the expiry day exclusive, and parsing the date month-first.

## Phase 11 — live entry is now a setting, not a source edit (DONE 2026-09-10)

The blocking complaint from the operator: "mujhe IRIS portal mein columns mein data fill karwana hai".
Writes were impossible without editing `lib/tax/fbr-agent-config.ts` by hand — a hardcoded
`automaticFilingEnabled: false` with a contract test asserting that literal. That is a guard worth
keeping and a wall worth removing, so the guard is now a **deployment setting**:

- `TAXROCKET_ALLOW_LIVE_FILING` (`true|1|on|yes`; anything else, including empty or a typo, is off)
  → `livePilot.automaticFilingEnabled` and `livePilot.mode: "supervised_live_filing"`.
- No DB table for it, deliberately: a row that silently enables portal writes would outlive the
  deployment that set it. `getFbrPortalAutomationConfig` is the only producer, so the server cannot
  disagree with itself.
- **Two keys remain required.** The operator's `TAXROCKET_REAL_AUTOFILL` (agent's shell — the agent
  reads no `.env`) plus this one. With only the first, the agent logs the downgrade and runs dry
  (`main.js:4013`), which is what the operator's last run did.
- The state is **visible**: the FBR panel's paragraph and button change ("Start supervised entry"),
  and a standing `role="alert"` names the variable, the packet version about to be written, and what
  live mode still will not do (upload / pay / save / submit). The off-case sentence
  ("It does not enter amounts…") was kept, not deleted — a deployment that is off must not lose its
  promise.
- What did **not** change: which cells may be written. `mappingVerified` is still
  `profile.id === "salary" && frame.salary.verified` (`iris-navigation.js:2862`), so live today writes
  the Salary grid only, and `allowUnverifiedTargets` is still unreachable from the web side — the new
  test asserts the client never mentions it, so the UI cannot loosen target verification.

`verify:fbr-contracts` (22 tests) now locks: stray values off, the four accepted spellings on, the
flag changing nothing else in the job context (field map, readiness, dryRun compared for equality),
and the UI copy. Mutation-checked: treating any non-empty string as on, hardcoding `true`,
inverting the component default, and leaving `mode` stale each failed the suite alone.

## Phase 12 — the coverage gate can now be accepted explicitly, and the acceptance is recorded (DONE 2026-09-10)

The P3.2 gate did its job on a real run and stopped a taxpayer at step 13:
`Packet not generated: interest income (50,000), reconciliation adjustment inflow (663,900),
test (100) has no verified IRIS line item…`. Correct refusal — but with no way forward, the
worksheet itself was unreachable, and the manual-entry path the message recommends needs the packet
as its worksheet.

So the refusal stays the default and the override is now an **explicit operator action**, three
changes deep:

- `describeUnmappedPortalSources(gaps)` in `lib/tax/portal-field-map.ts` owns the decision, the
  sentence and the record together. Splitting those three is how an override ends up dropping an item
  the refusal promised to keep visible: the acceptance records **exactly** the list the refusal
  named, and a zero or nameless entry is never counted.
- `generateFilingPacketAction(draftId, { acceptUnmappedPortalSources })` refuses unless that flag is
  true, returns `unmappedPortalSources` so the UI offers the choice from real numbers, and writes
  `snapshot.coverage = { mode: "partial_manual_entry_required", acceptedByOperator: true,
  unmappedSources: […] }` — the packet version permanently says it was partial and who accepted it.
  A `complete` packet records `{ mode: "complete" }`.
- The wizard shows a labelled checkbox — *"Generate anyway — I will enter these in IRIS myself"* —
  only while the gate is blocking. The handler compares `acceptUnmapped === true` and the button
  passes an explicit boolean, because that handler is also wired to a click: a `MouseEvent` is
  truthy, and a truthy accident would have silently switched a safety gate off.

What did **not** change: the agent still refuses to fill any of these sources (no verified IRIS line
exists), and the amounts are still shown as `mappingGaps` for the human to key. The override unlocks
the paperwork, not the writing.

`verify:portal-field-map` (14 tests) now runs the real helper — empty, junk input, mixed amounts,
zero and nameless entries, ordering of the refusal before the snapshot, and the invariant that every
category named in the sentence appears in the recorded list — plus static locks on the action, hook
and button. Mutation-checked: truthy accept in the hook, click event reaching the flag, `complete`
recorded despite an accepted gap, dropped nameless filter, and emptied record list each failed alone.

## Explicitly out of scope this session
- No live portal access, no IRIS account, no writes to any return.
- Not changing the gate/refusal philosophy: refusing to write is a **feature** (design rule at the
  top of `iris-row-filler.js`), and the "never answer the residency/sources gate" rule stays.
- Not touching tax calculation, rate card, or the approval gates.

## P6 (added after reading the earlier pass) — cross-check with `IRIS_AUTOFILL_ANALYSIS_2026-09-08.md` / `FBR_ELECTRON_PHASE_PLAN_2026-09-08.md` (`IRIS_AUTOFILL_ANALYSIS_2026-09-08.md`, `FBR_ELECTRON_PHASE_PLAN_2026-09-08.md`)

Each of its findings re-read against the repo **today**, not against its own notes:

| Earlier claim | Verdict | Evidence |
|---|---|---|
| "real mode is navigation-only, autofill never runs" | **OBSOLETE** | `runLocalTaxDryRunFlow` calls `runRealIrisAutofill` whenever `TAXROCKET_REAL_AUTOFILL` is `dry`/`live`; the operator's live run *did* autofill (`0/27`, 27 itemised refusals). |
| "`portalFieldMap` object-vs-array contract is broken" | **ALREADY FIXED** | `app/api/local-agent/jobs/[jobId]/context/route.ts:180` → `flattenPortalFieldMap(rawPortalFieldMap)`. What actually broke the run was *which column* the flattened entries targeted (P0). |
| "row container `id` is the IRIS code" | **SAME as P1** | `ROW_SELECTOR = ".tableRows.dataRow[id]"`; the shipped filler already works this way. |
| "left-section navigation must be text-based" | **ALREADY BUILT** | `SECTION_TOUR` + `navigateToSection` in `iris-navigation.js`. |
| "`routeMetadata` not reliably persisted/propagated" | **PARTLY VALID** | It is persisted (`app/actions/packet.ts:357`) and read (`route.ts:287`), but `buildPacketRouteMetadata` returns `routeFamily: null` + `requiresIdentification: true` for a business/unsupported filer and `requiresIdentification` has **zero consumers** (only producer: `route.ts:290`). So a business taxpayer gets a salary-shaped packet with no route, and nothing stops it. Fixing this changes approval behaviour → needs your call (P5). |
| "attachment automation is easy — `#doc_9230/#doc_3000/#doc_3003`" | **VALID, MIS-RANKED** | Verified: exactly 3 ids per capture, and they are on **every** return page (attachment is a node of the same document). But each is `<input hidden type="file" accept=".pdf">` behind an "Add File" button — outside this filler's text-write design, needs a new capability + safety review. Still P5, and not "easy". |
| "payment/PSID has no evidence" | **VALID** | `grep` over all 13 captures: `PSID` 0 hits, `Generate` 0 hits; live inspection shows payment/attachment with `0 grids / 0 rows`. No payment automation until a real capture exists. |
| `worker.md` stale (MySQL, `electron-connect/src/...`) | **VALID** | Confirmed independently: repo is PostgreSQL, paths do not exist. |
| Wizard FBR step checks `fbrConnectionStatus === "COMPLETED"` | **VALID — FIXED NOW** | The complete set of values anything writes to `FbrConnection.status` is `NOT_STARTED`, `WAITING_FOR_AGENT`, `DRY_RUN_QUEUED`, `FILING_QUEUED`, `PENDING`, `ACTIVE`, `EXPIRED`, `AGENT_CONNECTED`, `FAILED`, `DRY_RUN_COMPLETED`, `FILING_COMPLETED` — `"COMPLETED"` is in none of them (`grep status: "COMPLETED" app/ lib/ components/` → 0 matches), so that rail check could **never** turn green. |
| Standalone FBR page duplicates status logic / weak final gate | **PARTLY VALID — FIXED NOW** | Props added (`taxPayable`, `refundDue`, `packetVersion`) + a "Local agent" row using the shared predicate. Its hand-rolled `currentStatus` block is left alone: switching it to `getEffectiveFilingStatus` also adds document/transaction blockers, i.e. a visible behaviour change with no test here. |

## Local test bundle (what to replace, in one shot)

The two sides are different runtimes — replace the whole set, do not mix:

**Desktop agent** (`electron-connect/`, loose files, needs an agent restart):
`main.js`, `iris-navigation.js`, `iris-row-filler.js`, `README.md`
— the build-stamp guard now refuses to start if `main.js` / `iris-navigation.js` /
`iris-row-filler.js` disagree, so a partial copy fails loudly instead of filing wrong.

**Web/server** (`npm run build` + restart the dev server):
`lib/tax/portal-field-map.ts`, `lib/tax/iris-field-codes.ts`, `lib/tax/filing-status.ts`,
`lib/tax/cnic-profile.ts`, `app/actions/extraction.ts`,
`components/tax/filing/filing-wizard.tsx`, `components/tax/filing/wizard-documents-step.tsx`,
`components/tax/filing/hooks/use-filing-documents.ts`, `app/tax/fbr-connect/page.tsx`, `package.json`,
`scripts/verify-portal-field-map.cjs`, `scripts/verify-iris-row-filler.cjs`,
`scripts/verify-iris-navigation.cjs`, `scripts/verify-ty2026-filer-status.cjs`,
`scripts/verify-cnic-profile-plan.cjs`, `scripts/replay-agent-autofill.cjs`

Then: **old packets must be regenerated** — a packet built before P0 still carries
`column: "Amount Subject to Normal Tax"`, and the new filler will (correctly) refuse all of it.
Run with `TAXROCKET_REAL_AUTOFILL=dry` first; `live` writes only into sections the tour verified.

## Verification for this session (must all run green)
```
npm run verify:cnic-profile-plan     # NEW → 22/22 (CNIC → profile, expiry, cross-year reuse)
npm run verify:portal-field-map      # 14/14 (incl. the status-contract lock)
npm run inventory:portal-coverage    # NEW read-only: 463 portal codes, 397 never rendered,
                                     # 414 with no IRIS_CODES entry → the exact capture list
npm run verify:ty2026-filer-status   # its OLD assertion "FBR rail … === \"COMPLETED\""
                                     # asserted the bug; rewritten to lock the shared
                                     # predicate + the writer/consumer status contract
npm run verify:iris-row-filler       # 20/20 baseline → 27/27 (7 new P1 tests)
npm run verify:iris-navigation       # 80/80 baseline → 95/95 (P1–P4: probe, evidence, gates)
npm run verify:all                   # rule + packet suites — 13/13 suites exit 0
npm run build                        # ✓ Compiled successfully
node_modules/.bin/tsc --noEmit -p tsconfig.json   # clean
HOME=<dir with the captures> npm run replay:agent-autofill -- --job <latest-job.json>
    # NEW committed replay: dry-runs the real filler over the operator's captures and
    # prints "writeable targets found by replay: 6" vs the recorded "0/27 filled".
```
DB-backed suites (`verify:withholding-sources`, `verify:money-database`,
`verify:bank-statement-isolation`) and `verify:ui` cannot run here — no PostgreSQL in the sandbox
(the operator's `taxrocket-postgres` container is on their machine, port 5432→5432).
