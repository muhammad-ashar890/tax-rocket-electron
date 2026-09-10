# Electron-Connect (IRIS data-fill) — Analysis Only
Date: 2026-09-09 · No code changed · Repo `tax-rocket-new` @ `9a79d72` (main)

> **Read this first — parts of this document are superseded.** Two of its conclusions were
> drawn from `worker.md` + source reading, and the operator's live logs
> (`latest-job.json`, `latest-portal-inspection.json`) contradicted them:
> (1) `INCOME_SECTION_IDS` **does** include `tax_deductions` and `allowance_credits`, and
> **excludes** the two 116 wealth panels — so §S2 and §S3 below are wrong as written, and
> withholding `64020004` (s.149) **is** reachable (the live tour captured it, 7 views,
> `complete:true`); (2) the withholding `column_disabled` in this doc's simulation was a
> jsdom artefact, not a portal defect. §S4's "wealth is unreachable" framing also misled:
> the wealth rows are unreachable *by design of the 116 document*, not because of the tour.
> The corrected finding table, and what has since been fixed, is in
> **`FBR_FILL_PHASES_2026-09-09.md`** (P0 packet builder, P1 fill layer, P3 readiness probe —
> all implemented and green; P2 partly, P3 items 2-4, P4 and P5 open).

Inputs analysed: 13 `IRIS 2.0 *.html` portal captures, `IRIS_System_Field_Codes_Extracted.csv`
(535 rows / 463 distinct codes), `worker.md`, plus the agent code
(`electron-connect/main.js` 5777 l, `iris-navigation.js` 3553 l, `iris-row-filler.js` 504 l)
and the packet side (`lib/tax/iris-field-codes.ts`, `lib/tax/portal-field-map.ts`,
`lib/tax/fbr-agent-config.ts`, `app/actions/packet.ts`, `app/api/local-agent/jobs/[jobId]/context/route.ts`).

## 0. How this was verified (so findings are reproducible, not opinions)

| Check | Command | Result |
|---|---|---|
| Agent contract suites | `npm run verify:iris-navigation` | **80/80 pass** (needed `npx playwright install chromium`) |
| Build | `npm run build` | clean |
| Offline rule suites | 13 × `verify:*` | all exit 0 |
| Fill layer vs **real** IRIS captures | ran `iris-row-filler.buildInPageFillScript()` in jsdom over the 13 attached HTML | see §3 matrix |
| Fill layer vs repo fixtures | same, over `test-fixtures/iris/*.html` | see §3 matrix |

So the agent's own suite is green — the failures are **contract mismatches with the live portal and
the packet builder**, not broken internal logic.

---

## 1. Why the step never completes (structural reasons, ordered)

### S1. Autofill is switched off by default
`electron-connect/main.js:56` — `TAXROCKET_REAL_AUTOFILL` accepts `dry` / `1|true|on|yes`,
otherwise returns `"off"`. With `"off"`, `runLocalTaxDryRunFlow` (`main.js:3779` dry-run, `main.js:4158` assisted) calls
`finishNavigationOnly()` and **never fills anything**. The job is parked at
`awaiting_user_action` even when navigation succeeded.
There is no `.env` in the repo and `worker.md` never mentions this variable.

Related dead flag: `lib/tax/fbr-agent-config.ts:126,304` sets
`livePilot.automaticFilingEnabled: false` — grep shows **nothing reads it**, so it cannot be
used to distinguish "pilot" from "live" today.

### S2. The packet only contains codes from 3 of the sections IRIS actually has
The section tour the agent walks is `INCOME_SECTION_IDS`
= `salary → withholding → computations → wealth_assets → wealth_reconciliation`
(`iris-navigation.js:15-45,52-60`; caller `main.js:3443`).
`tax_deductions` and `allowance_credits` exist in `ALL_SECTION_TOUR` but are **not in the plan**.

> **CORRECTION (from the live log):** this list is wrong. `INCOME_SECTION_IDS` is
> `salary, tax_deductions, allowance_credits, withholding, computations, payment, attachment` —
> both sections ARE in the plan (they just sit inside `SECTION_TOUR` rather than the legacy
> constant quoted here), and the 116 wealth panels are the ones deliberately left out. The
> operator's run walked 7 views with `complete:true`, which is only possible with that set.

That matters because, in the client's captures, **salary withholding `64020004` (s.149) lives on the
`Tax Deductions` view**, not on `Withholding Tax`:

```
test-fixtures/iris/tax-deductions.html  rows: 999909 64020004 64020005 999910 64210051 64020007 999911 64210054 64210056
test-fixtures/iris/withholding.html     rows: 640000 64150002 64150002 64151905 64000101 64000102 64000103 324802
```

`planSectionFills()` (`iris-navigation.js:181`) never guesses a section for an unseen code
→ those codes fall into `unlocated` → `real_autofill_unlocated` → status `row_not_found`
(`main.js:3705-3717`). The single most common taxpayer field (149 salary tax) can therefore
**never** be filled by the current plan.

Also: `lib/tax/portal-field-map.ts:104-150` `getPortalNavigationHints()` hard-codes
`leftSection: "Withholding Tax"` for the whole `Tax Chargeable / Payments` area — a second,
independent statement of the same wrong assumption. (It is only advisory today, because
`runRealIrisAutofill` navigates from the tour, not from the hints.)

### S3. Wealth can't be reached from inside the 114(1) document — but it is still in the plan
`iris-navigation.js:46-51` documents that 116 is a separate document, yet `SECTION_TOUR`
still contains `wealth_assets`/`wealth_reconciliation`, so the tour spends two attempts on
panels that are not there (`panelFound:false`) and those fields go `row_not_found`.

> **CORRECTION (from the live log):** `SECTION_TOUR` does *not* carry the wealth panels into the
> 114(1) walk — `runSectionTour` is driven by `INCOME_SECTION_IDS`, which excludes them, and the
> captured tour confirms it (7 views, none of them wealth). The practical consequence stands but
> for a different reason: `buildPortalFieldMap` emits `wealthFields: []`, so nothing is queued for
> 116 at all, and 116 is a separate return that this flow does not open.
The `116 - Wealth Statement` panel *header* does exist inside the return (`form3.html`:
panels = `Employment`, `Tax Chargeable / Payments`, `116 - Wealth Statement`), which makes the
failure mode confusing rather than obvious.

### S4. Panel-expansion gate blocks section entry whenever the panel starts collapsed
`getPanel()` requires **exactly one** visible `mat-expansion-panel-header` with text equal to the
group, and `matchingSectionButtons()` returns `[]` unless that header reports
`panelExpanded` (`iris-navigation.js:1080-1140`). Two problems:

1. Live DOM truth (`IRIS 2.0 form3.html`): only **one** panel is expanded at a time
   (`Employment aria-expanded=false`, `Tax Chargeable / Payments expanded`, `116 …false`).
   So for the *other* group, `panelExpanded(header)` is false → `tabFound:false`.
   `navigateToSection` does click the header first (`section-panel`, `iris-navigation.js:2533`)
   and waits 16×300 ms — but any failure of that click becomes
   `status: panel_not_expanded` / `panel_already_active` and the whole section is skipped
   **without trying the left-tab button**, even though the button
   `button.data-tab-left-btn` is *always present* in the DOM for all 7 tabs
   (verified: `app-nitr-wf-body .body.interface_21.active button.data-tab-left-btn` → 7 matches
   on every captured Data-tab page).
2. Inside the Withholding view, IRIS renders **sub-panels** (`form 5.html`:
   `Employment, Tax Chargeable/Payments, 116, Adjustable Tax, Final Tax, Minimum Tax, Average Tax`).
   Any code that also appears as a group name makes the "exactly one header" test fragile.

### S5. The resume path reloads the dashboard, so "continue" restarts the journey
For the real portal every checkpoint URL collapses to the IRIS root
(`fbr-agent-config.ts:262-276`, `stageUrl()` → `https://iris.fbr.gov.pk/`), and the assisted flow
does `await windowInstance.loadURL(dashboardUrl)` when `pilotState.phase === "start"`
(`main.js:4208`, gated by `shouldFillReturn` at `main.js:4190`). After a pause/confirm, the SPA is reloaded to `/dashboard` and the agent must
re-enter the return by dbl-clicking the draft row (`navigateIris2DashboardFlow`, `main.js:658`).
Each resume is a full re-navigation — the most likely place for "step complete nahi hota".

### S6. `formReady` is proven by "any visible input", which is not a proof
`navigateIris2DashboardFlow` decides readiness by counting visible
`input,textarea,select` (`main.js:790-812`, `formReady: formOpen > 0`).
Measured input counts on the captures:

| page | visible inputs |
|---|---|
| `IRIS 2.0 blue tile.html` (Summary of Economic Transactions gate) | **10** (8 checkboxes + 2 radios) |
| dashboard | 0 |
| return form (any Data tab) | 148–171 |

So the pre-filing **gate page satisfies `formReady`**. The agent can believe the return is open while
it is standing on `/nitr/summary-economic-transactions`, then fill against a page with no rows.
The correct predicate already exists in the codebase: `returnWorkspace`
= `app-nitr-workflow` + `app-wf-header` + `Year 20xx` + `114(n)/116(n)` + `Registration No:`
(`iris-navigation.js:653-675`) — verified present in `form3.html`, absent on the gate page.

### S7. Legacy selector bundle is mock-era and can never match the live portal
`DEFAULT_SELECTOR_BUNDLE` (`fbr-agent-config.ts:158-230`) contains e.g.
`#iris-return-form-ready`, `form[data-iris-form-ready='true']`, `#return-tax-form`,
`a[href*='IncomeTaxReturn']`, `#top-menu-income-tax-return`.
Checked with jsdom against **all 13 captures: 0 matches for any of them**.
(`main.js:865-876`) tries `navigateIris2DashboardFlow` first and falls through to this chain, whose
final step is `verifyFormReady()` → false → throw
`"…target form was not detected as ready."` — and that string is one of the triggers for
"selector drift" (§S8).

### S8. "Selector drift" is a string-match guess, not a diagnosis
`main.js:1726-1752` `buildSelectorDriftDiagnostics()` fires whenever the error message contains
`"selector"`, `"timed out waiting for selector"`, `"missing selector"` or
`"target form was not detected as ready"`; `inferLikelySelectorGroup()` (`main.js:1690-1721`) then
labels the group from the last log step / more substrings.
So the very job in `last-agent-job.json` (`requiredAction: selector_bundle_update`,
`likelySelectorGroup: field_fill`) is an **inference** built on a dashboard DOM dump — not proof
that the fill selectors are wrong. The bundle metadata it reports is
`v8-default-2026-05-merged-with-iris-codes` v2, `source: default_code`.
There is no machine-checkable contract (selector → match count → expected cell state) behind it.

### S9. Version guards will silently brick a half-updated install
`main.js:71-77` `assertNavigatorBuild()` throws unless
`AGENT_BUILD_TAG === irisNavigation.BUILD_TAG` (currently both `fix16-new-return-setup-20260908`).
The Electron app is shipped as loose files inside `asar`; if an operator replaces `main.js` but not
`iris-navigation.js` (or vice-versa), the agent dies with
"Desktop files are mixed versions…". Same class of hazard: nothing verifies `iris-row-filler.js`
or `preload.js` belong to that build.

---

## 2. Value mapping problems (calculation engine → IRIS)

### M1. `category → code` covers 49 of 463 CSV codes
`lib/tax/iris-field-codes.ts` exports 49 codes. Unmapped counts by section (from the CSV):

```
Tax Chargeable / Payments / Minimum Tax                    61
Global Tax Return Tab / Minimum Tax                          59
Tax Chargeable / Payments / Adjustable Tax                   57
Business / Inadmissible / Admissible Deductions              48
Tax Chargeable / Payments / Computations                     39
Business / Mgmt, Admin, Selling & Financial Expenses         24
116 Wealth Statement / Reconciliation of Net Assets          22
Business / Manufacturing / Trading Items                     18
116 / Personal Assets + Personal Expenses                    35
Property / Receipts + Other Sources                          20
…
```
`CATEGORY_TO_IRIS_MAP` sends `DIVIDEND`, `BUSINESS`, `OTHER_INCOME` to the same code
`5028 "Other Receipts"` and `PENSION` to two different codes at once
(`1008` in Salary **and** `5007` in Other Sources) — double counting risk.

### M2. Fallbacks write into summary rows
- Unknown ledger category → `5028` (`portal-field-map.ts:336-352`).
- Unmapped tax section → `640000` = **"Adjustable Tax" summary row** (`portal-field-map.ts:437`), whose two cells are
  both `disabled` in the capture (`withholding.html: 640000[dd]`) → refusal.
Silent "put it somewhere generic" is the wrong behaviour for a government return; an unmapped
code must be a hard gate (block the packet), not a fallback row.

### M3. Every income line is forced into one column
`portal-field-map.ts:347` hard-codes `column: "Amount Subject to Normal Tax"` for all income fields
(only pension exempt/taxable splitting is column-aware, `:355-401`). Consequences:
- Bank profit / dividend are **final-tax** items; they should go to the
  `Subject to Final Tax` column (`verify:ty2026-tax-calculation` even reports
  `finalTaxRoutes: ["bank_profit"]`).
- Salary: the fill target column is computed/disabled on the captured view — see M4.
- Property 2031 (1/5th repairs) is written under `column:"Total Amount"` (`:404-431`) while IRIS
  renders it as a deduction line; sum/derivation must be confirmed.

### M4. Salary: the column we ask for is disabled, by IRIS design (in these captures)
Real row-filler against `test-fixtures/iris/salary.html` + `IRIS 2.0 form3.html`:

```
1000  column_disabled c3 (header_exact)     1049  column_disabled c3
1009  column_disabled c3 (header_exact)     1008  column_disabled c3
1089  column_disabled c3 (header_exact)
```
Cell editability per column on row 1009 (`EdEd` = 4 cells):
`0 Total Income` **editable**, `1 Subject to Final Tax` disabled, `2 Subject to Exemption` **editable**,
`3 Subject to Normal Income` disabled. The navigator *asserts this shape* as the expected salary
structure (`iris-navigation.js:1029-1037`; only reported, not enforced: `verified:` at 2362) — so the agent knows Normal-Tax is not writable and the
packet still asks for it. Either (a) salary must be written to `Total Income` and IRIS derives the
rest, or (b) the captures are of the **read-only/review** state, not edit mode. **This single
question decides the whole fill strategy.**

### M5. Column resolution falls back to "sole editable cell"
`iris-row-filler.js` resolution order: single column → `header_exact` → `header_partial` →
4-column positional fallback (`FOUR_COLUMN_FALLBACK`, which has **no** `TAX_COLLECTED` entry) →
`sole_editable`. `sole_editable` is how `923184` gets "filled c0" in
`computations.html` — i.e. it picks whichever cell is editable without proving the column identity.
Also `headerLabelsFor()`'s parent fallback takes the **last** `.heading-bar` inside the parent
(`iris-row-filler.js:246-252`); each panel render also carries two unrelated *depreciation*
heading bars (verified: `form3.html` has 3 heading bars: Salary grid + 2 depreciation tables),
so a row whose preceding sibling is not a heading bar can be matched against the wrong table's
headers.

### M6. `Occurrence_Index` / duplicate ids are handled only halfway
IRIS row ids are not unique: `64150002` appears twice in `withholding.html`
(`[dd]` summary + `[EE]` data row). `pickRow()` prefers "the one with an editable cell" and marks
`ambiguous_row` when >1 candidate is editable — good — but `buildPortalFieldRowSelector()` in the
packet emits `[id="64150002"]` (`portal-field-map.ts:94-102`) with no occurrence index, so the two
"pre-fill comparison" passes (`main.js:1646-1660`, `3988-4002`, `4410-4423`) hit the **first** match
via `document.querySelector` — the disabled summary row. All five `[data-tax-field-key=…]` sites (1649, 3990, 3999, 4412, 4420) also run
`document.querySelector` only, so any IRIS content inside a child frame/iframe is invisible to them
(the filler path is frame-aware, these three are not).

### M7. Numeric formatting is not modelled
Row inputs are `type="text"`, `text-right`, class `amount-cell-input`, with
`onkeypress="if (event.which > 57) return false;"` and a `thousandseparator` attribute.
The filler writes `input.value = String(field.value)` — a raw `1500000` with no
thousand separator and no rounding policy for paisa, and `String(1e21)` would emit `"1e+21"`.
No post-write re-read-and-recompare loop either (only `readback` of the same element).

### M8. Wealth statement is generated but never populated
`buildPortalFieldMap()` leaves `wealthFields: []` with the comment
"Actual wealth mapping needs user input — will be enhanced later" (`portal-field-map.ts:314` initialised, never filled; comment at lines 460-462),
while the tour includes `wealth_assets` and `wealth_reconciliation`. Reconciliation rows that *are*
writable in IRIS (`703002`, `7031`, `7032`, `7033`, `7088` — `[E]` in
`IRIS 2.0 form 9.html`) therefore receive nothing, and the wealth-reconciliation
step the app gates on can never be satisfied by automation.

### M9. `923183` vs `923184` description drift
`iris-field-codes.ts:76` labels `923184` "Surcharge u/s 4AB **(approx)**" while the CSV says
"Surcharge on high earning person u/s 4AB", and places `923183` (7E deemed-income tax) under
"Simplified Return of Income" — a route the packet always maps to
`normal_individual_114` (`portal-field-map.ts:200-246`), so 7E is unreachable for this route family.

---

## 3. Selector feasibility matrix (real row-filler × client captures)

Dry-run (`dryRun:true`, so no writes) using the agent's own `prepareField` + in-page script.

| Code | Meaning | Where the agent looks | Actual result on captures |
|---|---|---|---|
| `1000` | Total salary | salary | `column_disabled c3` — **never fills** |
| `1009`,`1049`,`1008`,`1089` | Salary lines | salary | `column_disabled c3` — **never fills** (c0/c2 are writable) |
| `2001`,`2031` | Rent, 1/5th repairs | *(no Property section in tour)* | **not present in any capture** |
| `500312`,`5028` | Bank profit, other receipts | *(no Other Sources section)* | **not present in any capture** |
| `4000` | Capital gains | *(not in tour)* | **not present in any capture** |
| `64020004` | Salary tax u/s 149 | `tax_deductions` — **not in tour** | `filled c1 (header_exact)` on `tax-deductions.html` only |
| `640000` | Adjustable Tax **summary** | withholding | `column_disabled c1` — fallback target is unfillable |
| `64040002`,`64080001`,`64150301`,`64151101` | 151(b), 155, 236C, 236K | withholding | **not present in any capture** |
| `923184` | Surcharge 4AB | computations | `filled c0 (sole_editable)` — identity unproven |
| `923183` | 7E deemed income | computations | **not present** (Simplified-return code) |
| `7012` | Cash in hand | wealth_assets | `filled c0 (single_column)` ✔ |
| `7001`,`7002`,`7006`,`7008` | Property/Investment/Vehicle | wealth_assets | **not present in captures** |
| `703002`,`7031` | Net assets PY, declared income | wealth_reconciliation | `filled c0 (single_column)` ✔ |
| `7013`,`7014`,`7019`,`7021`,`7029`,`703001`,`703003`,`7049`,`7099`,`703000` | computed wealth rows | wealth | all `disabled` → refusal (correct behaviour) |

Note also: `withholding.html`'s live 2-column headers are
`Taxable Amount | Tax Deducted` (and 3-col `…| Tax Chargeable`), **not** the CSV's
`Taxable Value | Tax Collected / Deducted | Tax Chargeable`. The row-filler's alias list
contains `"tax deducted"` and `"tax collected / deducted"` but no
`"tax collected/deducted"→"tax deducted"` normalization for the 2-column
Withholding grid, which is exactly why `640000` resolves via `header_exact` on
c1 and then gets refused as disabled.

## 4. What is genuinely good here (do not regress it)

- Frame-aware capture + action allowlist: `probeFrames`/`isAllowedPortalUrl` (https +
  `iris.fbr.gov.pk` only), "never accept a caller-provided selector/action"
  (`iris-navigation.js:2229-2262`).
- The economic-transactions gate is detected by stable custom elements
  (`app-summary-economic-transactions`, `app-source-checkbox`, overlay button
  `aria-label="Start Return Filling"`) — all verified present in `blue tile.html` — and the agent
  deliberately refuses to answer residency/sources (legal decision). Correct call, keep it.
- Fill refusals are explicit reason codes (`row_not_found`, `ambiguous_row`, `column_disabled`,
  …) with `readback`, and `describeFillSummary` prints skips. Honesty-by-design.
- Duplicate-row disambiguation by "prefer editable row" instead of `getElementById`.
- `PUBLIC_CODE_SET` (475 codes) covers 100% of the CSV codes + 12 extra codes that exist only in
  the live DOM (`1010`, `999901/2/3/5`, `700302`, `64000101`, …) — the allowlist is not the blocker.
- `heading-bar` + `.data-middle-child-wapper` positional model is the **right** model for IRIS 2.0
  (there are no `name`/`id`/`data-testid` on amount inputs at all — verified 0 occurrences).
- Migrations/prisma + all rule suites green; build clean.

## 5. Documentation drift (fix before anyone trusts it)

`worker.md`:
- says `MySQL` — repo is **PostgreSQL** (`prisma/migrations/…init_postgresql`, README).
- references `electron-connect/src/main.js`, `src/lib/ejari/local-agent.ts`,
  `src/app/fbr-connect/fbr-connect-client.tsx` — **none exist**; real paths are
  `electron-connect/main.js`, `lib/tax/*`, `components/tax/fbr-connect-client.tsx`.
- claims `fbr-connect-client.tsx` "not mounted" (README's `electron-connect/README.md` calls it
  "FIXED in Phase 1") — `app/tax/fbr-connect/page.tsx` does mount `FbrConnectClient`.
- never mentions `TAXROCKET_REAL_AUTOFILL`, `FBR_USE_MOCK_IRIS` interplay, the build-tag guard, or
  the section-tour model — i.e. the three things that actually decide whether a fill runs.
- `iris-row-filler.js:7` cites `FBR_PHASES_2026-09-08.md`, which is **not in the repo**.
- `NEEDS_RULES_IMPLEMENTATION.md` stops at §31 (2026-09-05); all IRIS phases (§32+) are
  undocumented, while 8 code phases + 6 commits went in since.

## 6. Evidence to collect next (no fixes yet)

1. **The agent's own diagnostic files on the operator's Windows box** — these are gold:
   `%USERPROFILE%\TaxRocketAgentLogs\latest-portal-inspection.json` (contains `sectionTour` with
   per-section `rows[]`, `cells`, `disabled`, `structureKey`, plus `interactionDiagnostics`) and the
   per-job log written by `writeJobLogToDisk` (`main.js:4797`, `4828-4830`).
2. **Edit-mode captures**: the same Salary / Withholding / Computations / Property / Other Sources /
   Capital Gains / Wealth views *while the return is being typed into* (not the read-only summary
   we appear to have) — needed to settle M4 and S6.
3. Missing schedules the packet maps but nothing was captured for: `Property (2001,2031,2099)`,
   `Other Sources (500312,5007,5028)`, `Capital Gain (4000…)`, `Adjustable Tax detail rows
   (64040002, 64080001, 64150301, 64151101)`, `Tax Deductions (64020004)`, `Payment` tab.
4. A real filing walkthrough log with `TAXROCKET_REAL_AUTOFILL=dry` (so `real_autofill_*` steps
   appear in `executionLog`) — currently every captured job ended before autofill ran.
5. Client rulings (blocking, from §1–§2): write salary to `Total Income` vs `Subject to Normal
   Income`? Are 151(b)/155/236C/236K advance taxes entered on `Withholding Tax` rows or on the
   `Computations`/`Tax Credits` grid? Is the 7E/`923183` code ever reachable from `114(1)`?
6. Dev-env note (from the Docker screenshot): `taxrocket-postgres` (`postgres:16`, host port 5432)
   matches the README `DATABASE_URL`; the sandbox has no Postgres, so the three DB-backed suites
   (`verify:withholding-sources`, `verify:money-database`, `verify:bank-statement-isolation`) and
   `verify:ui` remain **unchecked here**.

## 7. Proposed sequencing (for when we start fixing — nothing done yet)

1. Contract first: a machine-checkable **selector/structure spec per IRIS section**
   (section → panel group → tab label → heading-bar labels → per-code cell editability), generated
   from `latest-portal-inspection.json` + fixtures, and validated by a new suite that fails when IRIS
   shape changes. Replaces the S8 string-guess "drift" diagnosis.
2. Tour = source of truth for placement: include `tax_deductions`, `allowance_credits`; move 116 to
   its own phase; drop the mock `routeSelector` chain and the `#homeLink`/`countInputs` readiness
   (use `returnWorkspace` evidence instead) — kills S2, S3, S6, S7.
3. Remove packet fallbacks (`5028`, `640000`) → unmapped code must block packet generation, not
   target a summary row; add `Occurrence_Index` to the field contract — kills M2, M6.
4. Column policy per income type (salary vs final-tax vs exempt), driven by the section spec, and
   decide M4 with the client — kills M3, M5, M7 (money formatting: integer rupees, explicit
   `thousandseparator` policy, post-write readback compare).
5. Resume model: keep the same window and re-enter by identity check instead of `loadURL(root)`;
   add a per-phase "where am I" assertion — kills S5.
6. Ops hardening: single manifest for `main.js`+`iris-navigation.js`+`iris-row-filler.js`
   (build tag + hash) surfaced in the UI — kills S9. Then S1: make `TAXROCKET_REAL_AUTOFILL`
   explicit UI/CLI choice (off → dry → live) instead of an undocumented env var.
7. Rewrite `worker.md` against reality and start `NEEDS_RULES_IMPLEMENTATION.md` §32+ for IRIS.
