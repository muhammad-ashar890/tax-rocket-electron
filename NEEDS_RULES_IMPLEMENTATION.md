# NEEDS_RULES Implementation — WHT Rate Card (TY2026)

Client WHT rate-card PDF (14 pages) applied to every NEEDS_RULES case the
calculator can price. Figures below are the hand-computed expectations pinned
by the verify scripts; the engine is tested against them, not against itself.

## 1. Coverage

| Case | Before | After | Still NEEDS_RULES (and why) |
|---|---|---|---|
| Imports (Sec 148) | hidden card, unpriced | 10/10 rows priced (1%–6% ATL, doubled Non-ATL; mobiles by C&F band) | — |
| Advance tax (Sec 231AB–236Y) | hidden card, unpriced | 25/27 categories priced | 2 non-cc vehicle endnotes: no ATL/Non-ATL treatment stated |
| Pension: former-employer row | NEEDS_RULES | priced on salary slabs (row cites Sec 149) | — |
| Pension: age 70+ above 10m | NEEDS_RULES | exempt per Sec 12(2A)(i) | — |
| Dividend: mutual-fund proportional | NEEDS_RULES | priced from declared debt/equity split | missing/mismatched split still refuses |
| Agriculture | NEEDS_RULES | NEEDS_RULES | provincial tax, not on the WHT card |
| AOP / Company links | NEEDS_RULES | NEEDS_RULES | structure question, not a rate |
| Sales tax / FED / withholding | NEEDS_RULES | NEEDS_RULES | a different tax, not on the income-tax card |

Wizard now shows 15 income cards (was 13) and 10 category steps with 103
selectable cards (was 8 steps / 66 cards).

## 2. Key design decisions

1. **Collection split.** Imports and advance tax are collected at source, so
   their lines land in `collectionBreakdown` + `collectionTaxDue` and never
   touch `taxDue` / payable / refund / final-tax totals. The review step shows
   them under “Tax collected at source” with the explainer: claim with CPR /
   goods-declaration / bill evidence, not auto-credited. Packet PDF and FBR
   payload stay income-only automatically (they read draft columns).
2. **Declared figures ride the card.** Amounts the ledger cannot supply
   (import value, vehicle value + cc, seats, laden weight, bill, split
   portions, unit counts) are entered on the subcategory card, saved into
   `detailsJson.userDetails`, re-validated at calculation, and refuse with a
   named missing figure instead of pricing a guess. Editing a figure resets
   downstream results exactly like swapping the category.
3. **No guessing, anywhere.** Missing subcategory, unknown row, out-of-band
   value, wrong-card selection (per-kg vs fixed goods, shared vs split
   electricity), and non-adding splits all stop with NEEDS_RULES and a note
   that names the fix. `NOT_APPLICABLE` (ATL cash withdrawal, ATL domestic
   electricity) is a priced zero, not a refusal.
4. **Late filer is a filer.** Without a LATE_FILER row the ATL rate applies
   (236C/236K carry explicit late-filer rows and use them).
5. **`strict: false` narrowing.** Truthiness checks do not narrow the `ok`
   discriminant in this repo’s tsconfig; the code compares `=== false`
   explicitly (see note at the call site).

## 2b. Round 2 — Ordinance findings (mobile bands, pension 70+)

The rate card carries only min–max ranges for mobiles, so the band table was
transcribed from Part-II of the First Schedule to the Income Tax Ordinance
(amended up to 31.07.2025, i.e. the TY2026 law): 70/100/930/970/5000/11500 on
PCT 8517.1219 and 0/0/0/0/3000/5200 on 8517.1211 by C&F value in USD,
doubled for Non-ATL. The card’s ranges match that table’s min/max exactly,
and two independent TY2026 CA charts agree. Cards collect C&F USD (required)
plus an optional smartphone yes/no, needed only for CBU values at $30 or
less (band 1 is non-smartphones; a $30-or-less smartphone rides band 2).

Pension at 70+ is exempt however large (Sec 12(2A)(i): “shall not be charged
to tax on pension income”). The action passes a confirmed `SEVENTY_OR_ABOVE`
bracket as its own flag because `isBelow70: false` also covers turns-70 and
unknown — only a full-year 70+ gets the exemption; turns-70 still refuses.

## 3. Advance-tax pricing notes (rate-card pages 5–14)

- 231AB cash withdrawal: 0.8% Non-ATL; ATL not applicable.
- 231B(1)/(3): 0.5%–12% of vehicle value across 9 cc bands (Non-ATL ×3).
- 231B(2)/(2A): fixed 0–62,500 / 100,000–400,000 by cc band.
- 231C: Rs 200,000 / 400,000 per foreign domestic worker.
- 234 goods: Rs 2.50/kg to 8,120 kg, fixed Rs 1,200 above (alternative cards,
  cross-redirect).
- 234 passenger: Rs 200/500/1,000 per seat across 4–9 / 10–19 / 20+ bands.
- 234 annual/lump-sum private vehicle: 7 fixed cc bands each.
- 235 shared commercial/industrial to Rs 20,000 (0 to 500, 10% above);
  marginal rows above (1,950 + 12% commercial, + 5% industrial); commercial /
  industrial cards fall back to the shared band at ≤ 20,000 citing both rows.
- 235 domestic: 7.5% Non-ATL at ≥ Rs 25,000; zero below; ATL not applicable.
- 236 landline: 10% above Rs 1,000 (zero at/below); internet/mobile prepaid 15%.
- 236A auction: 10%/20% movable, 5%/10% immovable-or-railways.
- 236C transfer: 4.5/5/5.5% ATL, 11.5% Non-ATL, 7.5/8.5/9.5% late across
  50m/100m bands. 236K purchase: 1.5/2/2.5% ATL, 10.5/14.5/18.5% Non-ATL,
  4.5/5.5/6.5% late.
- 236CA: Rs 1m per serial episode, Rs 3m single-episode play, Rs 100,000 per
  ad second. 236CB functions 10%/20%. 236Y card remittance 5%/10%.

## 4. Files changed (18)

Engine + rules:
- `lib/tax/tax-calculation.ts` — collection routes, advance-tax branches,
  composite splits, pension-as-salary, allowlists, test exports
- `lib/tax/rules/ty2026/subcategories.ts` — detail-field contract (33 cards),
  sanitizer, resolve passthrough, persisted-details parser
- `lib/tax/rules/ty2026/catalog.ts` — ATL NOT_APPLICABLE on 2 domestic-235 rows

Actions:
- `app/actions/filing.ts` — details save/resume, figure-aware invalidation
- `app/actions/tax-calculation.ts` — activity routing, split attributes,
  pension flag, missing-figure blocker, line persistence
- `app/actions/filing-summary.ts` — income/collection split + subtotal

UI:
- `components/tax/filing/wizard-setup-step.tsx` — Imports + Advance Tax cards
- `components/tax/filing/config/filing-wizard-config.ts` — card list + summary type
- `components/tax/filing/wizard-income-subcategory-step.tsx` — figure inputs
- `components/tax/filing/filing-wizard.tsx` — details state wiring
- `components/tax/filing/wizard-review-step.tsx` — collection section + labels
- `components/tax/filing/wizard-packet-step.tsx` — source labels

Scripts + config:
- `scripts/verify-advance-tax.cjs` — NEW, 620 assertions
- `scripts/verify-flat-income-routes.cjs` — imports cases, dividend split, pins
- `scripts/verify-ty2026-subcategories.cjs` — 10 steps / 103 cards, contract tests
- `scripts/verify-tax-breakdown-surfacing.cjs` — collection path
- `scripts/verify-ty2026-filer-status.cjs` — late-filer fixes (was stale on HEAD)
- `package.json` — `verify:advance-tax` wired into `verify:all`

No migration needed: figures reuse `detailsJson`; lines reuse
`FilingTaxCalculationLine`.

## 5. Verification results

- `npx tsc --noEmit` — clean.
- `npm run verify:all` — every suite passes except
  `verify:withholding-sources`, which fails identically on the pristine tree
  (needs a live `DATABASE_URL`; environmental, not a regression).
- New/updated suites: advance-tax 620, flat-routes (imports + split),
  subcategories 230, surfacing 95, filer-status 30 assertions.
- UI suites (`verify:ui-*`) need Playwright browsers + server + DB; not run
  here — run on the PC before sign-off.

## 6. Open items for the client

1. Non-cc (electric) vehicle endnotes: the Ordinance gives single values
   (3%, Rs 20,000) while the Tenth Schedule raises all 231B collection 3×
   for Non-ATL (9%, Rs 60,000). Which reading applies — and does the
   10%-per-year reduction run on the doubled figure? Needs a
   consultant ruling before implementation.
2. Mutual-fund debt portion paid to a company: KPMG and TAGCO TY2026 charts
   say 29%/58% vs 25%/50% for others; the FBR card shows no such split.
   Engine currently charges 25%/50% for all recipients.
3. Collection credit (Q13): collected amounts are reported, never
   auto-credited against payable — confirm this stays manual.
4. Agriculture / AOP / sales-tax cards still stop the estimate by design;
   confirm that is the desired behaviour (vs. excluding them from gating).

Done since round 1: mobile bands (Ordinance Part-II table), pension 70+
exempt (Sec 12(2A)(i)). Files touched in round 2: `lib/tax/tax-calculation.ts`,
`lib/tax/rules/ty2026/subcategories.ts`, `lib/tax/rules/ty2026/catalog.ts`,
`lib/tax/rules/ty2026/catalog-tests.ts`, `app/actions/tax-calculation.ts`,
`components/tax/filing/wizard-income-subcategory-step.tsx`,
`scripts/verify-flat-income-routes.cjs`,
`scripts/verify-ty2026-tax-calculation.cjs`,
`scripts/verify-ty2026-subcategories.cjs`.

## 7. Source hierarchy (standing client rule)

1. The FBR WHT Rate Card PDF supplied by the client
   (`uploads/20258181281745641WHT-RateCard.pdf`, extracted text in
   `wht-ratecard-extracted.txt`) is the TOP authority for every rate.
2. The Income Tax Ordinance / CA charts / web research may only FILL GAPS
   where the card is silent or gives ranges (mobile bands, pension 70+).
   They must NEVER replace or override an existing card rule.
3. Applied consequences: mutual-fund debt stays 25%/50% for all recipients
   (card has no company split — the Ordinance's 29% proviso is flagged to
   the client instead of implemented); non-cc endnote values stay refused
   (card gives single values with no ATL split); pension finality stays as
   coded (the card carries no Final/Adjustable labels at all) until the
   client rules.

## 8. Round 3 — aggregation rule resolved (Ordinance)

The ">1 PROGRESSIVE" refusal is gone. The assessment rule comes from the
Ordinance (the card prices deduction at source and is silent here, so this
fills a gap and overrides no card row):

- Salary, individual/AOP rental and a pension taxed as salary share ONE slab
  read against their combined taxable income. Clause (2) (salaried table,
  same bands as Section 149) applies where salary-head income exceeds 75%
  of the total, else clause (1) (bands transcribed from the Ordinance and
  cross-checked with PwC: 0/15/20/30/40/45%, shared with AOPs). The 4AB
  surcharge runs on the combined
  figure above 10m at 9% with salary-head income, else 10%.
- A pension charged as final tax (0% to 10m, 5% above) stands apart and
  never enters the total (Sections 12(2A), 169); its lines are now flagged
  final, so over-withholding claims no automatic refund. The 70-plus limb
  stays non-final (exempt, not charged as final tax).
- Rental enters the combined figure at gross rent; Section 15A deductions
  still require review. Single-source rental still prices on the card's
  Section 155 WHT slabs (card-faithful; assessment on net is a future item).
- A company rental stays a flat percentage of its own rent and never joins.

Files touched in round 3: `lib/tax/tax-calculation.ts`,
`scripts/verify-ty2026-tax-calculation.cjs`,
`scripts/verify-tax-breakdown-surfacing.cjs`,
`scripts/verify-flat-income-routes.cjs`. No catalog, action or UI change was
needed (no new inputs). All 9 runnable suites pass; tsc clean.

## 9. Standing research rule: TY2026 law only

Every rate, band and treatment implemented or researched is for Tax Year
2026 (July 2025–June 2026, i.e. the Finance Act 2025 law). Sources dated
after June 2026 (TY2027 material) must be excluded or flagged, never
silently applied. Anchor documents: the client's FBR WHT Rate Card
(TY2026) and the Income Tax Ordinance amended up to 31.07.2025.

## 10. Round 4 — turns-70 policy (Option A, first-day rule)

A pensioner whose 70th birthday falls inside TY2026 (69 on 1 July 2025, 70
on 30 June 2026) is priced on the below-70 row for the whole year: 0% to
10m, 5% + 10% surcharge above. The law and FBR are silent on mid-year
birthdays; the client chose Option A (test age on the first day of the tax
year), following the Ordinance's own tradition for age tests — the former
60+ relief applied to a taxpayer "aged 60 years or more on the first day
of that tax year". Implemented in `assessPensionerAge` (turns-70 now
reports `isBelow70: true` while keeping the TURNS_70_DURING_YEAR bracket);
no engine change was needed. Options B (last-day test) and C (pro-rata)
were presented and rejected.

## 11. Non-cc (231B endnote) specials — IMPLEMENTED 2026-09-05

Direct engine pricing for BOTH endnote rows; the last two NEEDS_RULES advance-tax
categories are now priced (27 priced / 0 unpriced). Card supremacy preserved: the
4% figure never leaves the card; the engine applies the uplift exactly as it does
for mobile rates.

- Registration/sale at Rs 5m+: filer 3% (card endnote 1), Non-ATL 9% (Tenth
  Schedule R.1 proviso raises ALL Section 231B collection by 200%; corroborated
  by Moore Shekha Mufti's TY2023 chart printing 3%/9%).
- Transfer at Rs 5m+: filer Rs 20,000 (card endnote 2), Non-ATL Rs 60,000,
  reduced 10% per completed year from first registration, compounded
  (20,000 x 0.9^n) — the simple reading would hit zero at 10 years with no
  floor clause in the endnote.
- New input `vehicleAgeYears` (completed whole years, 0 = first year; non-integer
  or missing refuses the estimate). A registration-date input was rejected: the
  Ordinance and endnote count completed years with no transaction-date anchor, so
  a date would add a false-precision conversion.
- Value below Rs 5m: NO rate exists, so the estimate is refused with a
  "confirm with excise" note — never priced as zero.
- LATE_FILER pays the filer rate on both rows: late filers appear on ATL, so the
  proviso's non-ATL uplift does not hit them.

Deferred confirmations drop 4 -> 2 (only the two Sukuk BELOW-1M boundary notes
remain). Files: lib/tax/tax-calculation.ts, lib/tax/rules/ty2026/catalog.ts,
lib/tax/rules/ty2026/catalog-tests.ts, lib/tax/rules/ty2026/subcategories.ts,
app/actions/tax-calculation.ts, scripts/verify-advance-tax.cjs,
scripts/verify-ty2026-subcategories.cjs, NEEDS_RULES_IMPLEMENTATION.md.

## 12. Sukuk exact-PKR-1m boundary — CLIENT QUESTION (noted 2026-09-05)

Research proved the gap is STATUTORY, not just a card omission: the First
Schedule says "more than one million" (12.5%) vs "less than one million"
(10%); Sections 151(1A) and 152(1DB) only reference the division; the FBR
card mirrors the statute verbatim; the Karachi Tax Bar chart and NCCPL (the
actual GIS deducting agent) reproduce the same words; no FBR clarification
exists; one TY2027 page printing "up to 1m" is out of scope and internally
contradictory. Engine refusal (NEEDS_EXTERNAL_DETAIL note on the 2 BELOW-1M
rules) is correct. USER DECISION: keep the refusal, ask the client what
exactly-1,000,000 should price at. No tie-break implementation unless the
client or FBR directs one.

## 14. VPS/private pension (Sec 39) — LEFT OUT per user decision (2026-09-05)

Full research done: Circular 01 charges VPS/private pension under Sec 39;
Sch-II (23A) exempts the 50% lump sum at retirement; excess/early
withdrawals go at the 12(6) 3-year average rate; the (23B) monthly-stream
exemption was omitted by FA2022 so the monthly pension is fully taxable at
normal slabs; 156B was omitted by FA2020 so no WHT card row exists. USER
DECISION: VPS is not in the user's rate-card PDF, so no build at all — no
subcategory, no warning. Recorded consequence: VPS has NO card/row in the
engine, so no NEEDS_RULES can ever surface for it; but if a user enters VPS
pension on the government-pension card the engine will unknowingly apply
12(2A). Revisit (chat options A/B/C, 2026-09-05) only if the client asks.

## 15. P1#4 withholding-duplicate gate — IMPLEMENTED 2026-09-05

The salary-certificate/ledger double-count warning was advisory only: the
Review step showed it but approval and packet generation never required
confirmation, so a double-counted figure could be filed and surface months
later as an FBR notice. Fixed end to end, no schema change:

- lib/tax/withholding-sources.ts: hosts extractMappedSalaryWithholding
  (moved verbatim from the tax-calculation action) plus a new
  getWithholdingDuplicateWarning(draftId, userId) that re-derives the
  warning from live DB state, mirroring the action's salaried-route check
  exactly so a stale certificate cannot strand a non-salary filing.
- app/actions/filing.ts: confirmFilingForPacketAction takes
  withholdingDuplicateConfirmed and adds a server-side blocker when a live
  warning stands unconfirmed. Direct action calls face the same gate as
  the UI; the persisted approval is the proof (recalc revokes it).
- app/actions/filing-summary.ts + FilingSummary type: the summary carries
  a freshly recomputed withholdingWarning on every load (mount, ledger
  change, recalc), so a page reload can never hide the question.
- Wizard: Review step shows a mandatory checkbox under the warning
  (data-testid="withholding-duplicate-confirm"); the approval checkbox
  stays disabled via approvalBlockers until it is ticked; the tick resets
  on every recalculation.

Verified here: tsc clean + 9/9 runnable suites. DB + browser proof must
run on the user PC: verify:withholding-sources (DATABASE_URL),
verify:ui-03-calculation, and the manual click-through (seed salary cert
2L + "salary tax" ledger row 2L -> warning + blocked approval -> tick ->
approval works -> recalc resets).
Files: lib/tax/withholding-sources.ts, app/actions/tax-calculation.ts,
app/actions/filing.ts, app/actions/filing-summary.ts,
components/tax/filing/config/filing-wizard-config.ts,
components/tax/filing/hooks/use-filing-finalization.ts,
components/tax/filing/wizard-review-step.tsx,
components/tax/filing/filing-wizard.tsx, NEEDS_RULES_IMPLEMENTATION.md.

## 16. Final submit gate (FBR step) — IMPLEMENTED 2026-09-05 (client request)

Client: "we need a gate in the end that asks us to submit or not." The
desktop agent already pauses at final_submit_confirmation before pressing
Submit in IRIS, but the web UI showed the same generic "Continue" as for
OTP/PSID pauses, with no finality and no figures. Fixed:

- components/tax/fbr-connect-client.tsx: a final pause now renders a
  distinct red gate card — "Final gate: Submit this return to FBR?" — with
  packet version, tax payable and refund due, an explicit warning that
  submitting is final in IRIS, and three actions: Yes submit to FBR /
  Not now (collapses to a "nothing submitted" reminder, reopens any time;
  a fresh pause always reopens the gate) / Cancel this filing.
  (data-testid="final-submit-gate|final-submit-yes|final-submit-no").
  OTP/PSID/payment pauses keep the generic Continue card untouched.
- app/actions/fbr-jobs.ts: resumeJobAfterPauseAction refuses a final-pause
  resume unless resumeData.finalSubmitConfirmed === true, so a direct
  action call or stale button cannot submit. Only caller is the gate.
- Wizard plumbing: filing-wizard -> wizard-fbr-step -> client carries
  taxPayable/refundDue/packetVersion (optional; gate works without them).

Verified here: tsc clean + 9/9 runnable suites. Live proof needs the
desktop agent on the user PC: run to the final pause, gate appears with
figures, Not now collapses, Yes submits, direct resume without the flag
is refused.
Files: components/tax/fbr-connect-client.tsx, app/actions/fbr-jobs.ts,
components/tax/filing/wizard-fbr-step.tsx,
components/tax/filing/filing-wizard.tsx, NEEDS_RULES_IMPLEMENTATION.md.

## 17. TY2027 hidden from UI — pilot is TY2026-only (2026-09-05, user order)

SUPPORTED_TAX_YEARS is now [2026]. All three year selectors (wizard
tax_year step, profile form, profile page) derive from that list, so 2027
vanishes from the UI with no per-screen edits; the wizard default clamps
to the last supported year so it can never open on a rejected year; the
server guards (filing/settings/user actions) now reject anything but 2026
with "Only Tax Year 2026 is currently supported". Existing 2027-rejection
pins (subcategories "never leak into TY2027", tax-calculation
unsupported-year case) still pass unchanged. To re-enable 2027 later:
restore the list entry, add its rule set, and revisit this section.
Files: lib/tax/tax-year-period.ts, app/actions/filing.ts,
app/actions/settings.ts, app/actions/user.ts,
components/tax/filing/filing-wizard.tsx, NEEDS_RULES_IMPLEMENTATION.md.

## 18. Repo cleanup + README rewrite (2026-09-05, user order)

Deleted 13 unreferenced files (all committed, recoverable via git):
dead components profile-form.tsx (superseded by app/tax/profile/page.tsx),
fbr-connect-panel.tsx (superseded by fbr-connect-client.tsx),
active-filing-switcher.tsx (never rendered), ui/skeleton.tsx (only the
switcher used it); stale artifacts test-documents.zip (older copy of the
folder) and wht-ratecard-extracted.txt (rules live in catalog.ts); stale
docs OLD_REPO_ANALYSIS, LATE_FILER_FIX_INSTRUCTIONS, TESTING_LATE_FILER,
FBR_CONNECT_ANALYSIS, FBR_IMPLEMENTATION_SUMMARY, PHASE_PLAN_FBR_CONNECT,
PORTAL_FIELD_MAP_PROPOSAL. Kept: README, NEEDS log, INSTALLER_BUILD,
ANALYSIS_REPORT + CLIENT_QUESTIONS (decision record), fixtures,
audit scripts. README rewritten: accurate requirements, .env template,
setup/verify/deploy commands, agent separation note, honest production
remainder list. Verified: tsc clean + 13/13 offline suites.

## 19. Fake-settings cleanup: 2FA + dead plumbing + dead link (2026-09-05)

User order: remove 2FA-style placebo settings. Audit proved:
- twoFactorEnabled was stored (DB column + settings state) but had NO UI
  toggle and ZERO readers/enforcement (login is Google-only, no TOTP).
  Removed from settings page + settings actions + Prisma schema, with a
  hand-written migration (20260905120000_remove_two_factor) dropping the
  column. PC: `npx prisma migrate deploy` applies it.
- autoAdvanceStatus was forced false on load AND save with zero readers.
  Removed from settings types/page (JSON prefs only, no migration).
- Dashboard sidebar "Contact Support" card linked to href="#" with no
  support address anywhere in the repo. Card removed.
- Verified REAL and kept: all 5 notification toggles (createNotification
  enforces via NOTIFICATION_PREFERENCE_BY_TYPE), autoGeneratePackets
  (filing.ts reads it), default tax year, PKR display, session modal.
  Sweep found no other empty handlers or dead links in app/components.
Files: app/tax/settings/page.tsx, app/actions/settings.ts,
prisma/schema.prisma, prisma/migrations/20260905120000_remove_two_factor/migration.sql,
components/tax/dashboard-sidebar.tsx, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 13/13 offline suites + zero leftover refs.

## §20 Placebo-sweep fixes: /tax/guide page + profile name-trap (2026-09-05)
User approved #1 (build page) + #3 (fix); asked #2's solution first; #4 left
blank; #5–#8 not yet ordered. Implemented:
(a) NEW app/tax/guide/page.tsx — "How it works" 8-step flow (Profile → New
Filing → uploads → review → Mizan → packet → FBR Connect → History, real links
only) + "NTN / CNIC Guide" mini-section (CNIC-becomes-NTN, Profile entry,
ATL-from-filing, external FBR Iris e-registration link). Session-guarded like
other /tax pages. Sidebar link now /tax/guide#ntn-cnic, hero button now
/tax/guide#how-it-works (section ids + scroll-mt).
(b) Profile Full Name trap fixed: new nameLocked state (locked iff session or
DB name present); field unlocks + shows hint when both empty; validation
unchanged. Email left locked (impossible-empty: auth is email-keyed).
(c) SWEEP CORRECTION: colon-style `href: "/..."` links were missed by the
first audit — sidebar ALSO links /tax/mizan + /tax/calculators, NEITHER page
exists (404). Reported to user, awaiting decision (remove links vs build).
#2 solution reported (delete demo handler+button+prop ~30L, zero UI change);
#4 (Help button) + #5–#8 pending user order. No migration.
Files: app/tax/guide/page.tsx (new), app/tax/profile/page.tsx,
components/tax/dashboard-sidebar.tsx, components/tax/taxpayer-dashboard.tsx,
NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites (withholding-sources skipped,
needs live PostgreSQL — same as before, engine untouched).

## §21 Help-button wired + sweep decisions (2026-09-05)
#4 DONE: header Help icon (was dead "Coming soon" button, no handler) is now
a Link to /tax/guide, restyled from grey to active brand color. User orders:
mizan/calculators 404 links LEFT AS-IS ("keep" — revisit later); #2/#5–#8
bundle NOT approved yet (user asked for re-explanation, solutions re-reported,
awaiting order). No migration.
Files: components/site-header.tsx, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean (15/15 suites already green on this tree, §20).

## §22 Demo-code deletion + badge removal + comment fix (2026-09-05)
User orders executed: #2 DELETE (demo packet path), #5 REMOVE badge, #8 FIX
comment. #2: approval-packet.tsx lost handleGeneratePacket (fake 1.5s delay +
"(Demo)" alert), the Generate Packet PDF button block, showGenerateButton /
draftId / onCancel props, isGenerating state, and now-unused Button/Download/
Loader2 imports; title/description branches simplified. Caller
wizard-approval-step.tsx dropped the 3 dead passes (+ unused destructure).
#5: "Redesign Demo" pill deleted from auth-shell (login/signup screens) AND
bonus: browser-tab title + meta description in app/layout.tsx ("TaxRocket —
Redesign Demo" / "Standalone UX demo...") rewritten — same order, same family.
#8: filing-wizard "Demo-only" comment rewritten (createAction contract is real;
only the word was stale). User asked LOCATIONS of #6 (Practitioner branch:
taxpayer-dashboard.tsx isPractitioner prop → "Practitioner Daftar" badge +
"Clients" KPI, unreachable), #7 (QuickLinkCard: same file bottom, unrendered),
and Mizan/Calculators (sidebar quick-links → 404, kept per earlier order).
All pending re-approval; nothing else removed. No migration.
Files: components/tax/approval-packet.tsx,
components/tax/filing/wizard-approval-step.tsx, components/auth/auth-shell.tsx,
components/tax/filing/filing-wizard.tsx, app/layout.tsx,
NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + zero leftover refs (use-filing-finalization
handleGeneratePacket* is the SEPARATE real flow — kept).

## §23 Practitioner/QuickLink deletion + dead sidebar quick-links (2026-09-05)
User: "krdo" (#6+#7) + mizan/calc "jo sahi lagta h krdo". #6: deleted the
UNREACHABLE practitioner branch from taxpayer-dashboard.tsx only
(isPractitioner/clientCount props, "Practitioner Daftar" badge branch,
"Clients" KPI branch → Tax year card is now unconditional). filing-wizard's
own isPractitioner (setup gating, :523/:803/:822) is SEPARATE real logic —
untouched. #7: deleted unrendered QuickLinkCard (same file bottom).
CORRECTION: sidebar quick-links (mizan/calculators/guide) were inside a
{/* commented */} block — NEVER rendered; earlier "visible in sidebar" claim
was wrong (array read, render missed). Decision: deleted the dead array +
commented block + now-unused Scale/Calculator/CreditCard imports (guide stays
reachable via hero button + Help icon). Zero UI change by construction.
No migration.
Files: components/tax/taxpayer-dashboard.tsx,
components/tax/dashboard-sidebar.tsx, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites + zero leftover refs. Sweep
items #1–#8 ALL closed. Workspace ready for user download + PC testing.

## §24 Sticky wizard navigation (2026-09-05)
User: Back/Continue bar demanded sticky-bottom (no scroll-hunting on long
steps). WizardNavigation outer div is now `sticky bottom-0` with
bg-background/95 + backdrop-blur + z-10; no overflow-hidden ancestor in the
wizard column, so viewport sticking works on desktop + mobile. No logic or
gating change. Readiness-cards removal + ahead-enforcement pending user
answers (which-3 + where-required).
Files: components/tax/filing/wizard-navigation.tsx,
NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean.

## §25 Readiness trim + Iris gate before FBR Connect (2026-09-05)
User (testing on PC): drop CNIC/NTN + Iris + Mobile/Email cards from the
readiness screen (identity3); CNIC upload stays required at documents step;
Iris login must exist before the last step. Implemented:
(a) readinessOptions trimmed to Previous Return + Core Documents in BOTH
lists (config + setup-step local); unused CreditCard/CircleDot/Mail icons
removed. Defaults now ["core_documents_ready"]; resume path filters retired
values so old drafts can't show "3 of 2 ready". TaxReadinessItem type values
KEPT for DB back-compat (existing drafts still parse).
(b) CNIC upload: NO CHANGE NEEDED — verified already required: cnic slot is
always required:true (CORE_DOCS) and goNext on documents blocks Continue
("Review and approve/map all required documents...") until
COMPLETED/MAPPED. Reported as already-live.
(c) Iris gate: new irisLoginConfirmed state (filing-wizard, session-only
self-attestation like approval); packet step (directly before fbr_connect)
shows required checkbox "I have created my FBR Iris login *" with link to
/tax/guide#ntn-cnic (FBR Iris e-registration); Continue to FBR disabled
until packet generated AND checkbox ticked (mirrors approval gating).
Mobile/Email: no enforcement added (email always from Google; phone stays
optional) per "agay ka sb wese hi rhega".
Files: components/tax/filing/config/filing-wizard-config.ts,
components/tax/filing/wizard-setup-step.tsx,
components/tax/filing/filing-wizard.tsx,
components/tax/filing/wizard-packet-step.tsx, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites + zero stale refs/icons.
Note: sticky nav (§24) + this §25 both untested on PC yet — user to verify.

## §26 Readiness gate: all cards required (2026-09-05)
User (PC testing): Continue must not work until every shown readiness card is
tapped. canGoNext now returns false on "readiness" unless readinessCompleted
covers all readinessOptions (currently Previous Return + Core Documents);
readinessCompleted added to the memo deps. Step description updated ("Tap
each card to confirm - everything here is needed to continue") since the old
"no worries if missing" contradicts the gate. NOTE flagged to user:
first-time filers have no Previous Return yet must tap it to proceed; offered
to scope the gate to Core Documents only if preferred. No enforcement change
elsewhere.
Files: components/tax/filing/filing-wizard.tsx,
components/tax/filing/wizard-setup-step.tsx, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites.

## §27 Section refs off cards + Sukuk pending-confirmation hide (2026-09-05)
User (PC testing): (a) drop "Section ..." from under subcategory cards,
(b) hide the client-confirmation Sukuk card(s) until confirmed.
(a) wizard-income-subcategory-step no longer renders the Section line; cards
with >1 rule keep only "N amount/rate bands", single-rule cards show no
sub-line. Also stripped Section refs embedded in 3 advance-tax
LABEL_OVERRIDES (purchase/registration, transfer, lease stay distinct) and
the 231B(2) prefix on the non-CC vehicle label. NOT stripped: non-resident
(152) card labels — those cards ARE identified by sub-section (1/1A/1DB...)
and stripping would erase meaning; flagged to user.
(b) UI-only HIDDEN_PENDING_CONFIRMATION filter in the same step file hides
bank_profit:sukuk-individual-aop-below-1m AND its twin
foreign_income_assets:1db-sukuk-individual-aop-below-1m (BOTH carry
NEEDS_EXTERNAL_DETAIL with the same exact-1m note = the deferred=2 pin).
Data layer untouched so saved drafts still validate and the 106/152/103
suite pins pass; restore = delete the set. Pension auto-derive (Q3) NOT
implemented yet — findings + proposal put to user (working-card IS
functional: pensionTaxAsSalary reads the former-employer selection).
Files: components/tax/filing/wizard-income-subcategory-step.tsx,
lib/tax/rules/ty2026/subcategories.ts, lib/tax/rules/ty2026/catalog.ts,
NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites.

## §28 Pension full-auto: amount cards gone, working-card kept (2026-09-05)
User approved full-auto. Findings: engine already derives the pension band
from the ledger pension amount + profile/CNIC date of birth (setup amount
cards were ceremonial), BUT the working card is functional (tax-calculation
action sets pensionTaxAsSalary when former-employer-or-associate is
selected). Implemented: (a) UI-only AUTO_DERIVED_NO_CARD hides
pension-up-to-10m + pension-above-10m-below-age-70 (permanent, data intact);
(b) pension step description rewritten (one question only, bands automatic);
(c) pension gate relaxed at all 5 points: canGoNext true, resume clamp skip,
canSubmit skip, action-items skip, resolve requireComplete skips pension
(suite has no pension-completeness pin — safe). Working card + its engine
path untouched.
Files: components/tax/filing/wizard-income-subcategory-step.tsx,
lib/tax/rules/ty2026/subcategories.ts, components/tax/filing/filing-wizard.tsx,
NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites.

## §29 Mixed-regime excess withholding flag (other-chat P0 #1, 2026-09-05)
Other chat found (confirmed): mixed return + withholding above liability
produced a silent refund claim although final-side over-deduction is never
refundable — engine line was `refundDue = max(0, W - taxDue)`. No principled
cap exists without per-route withholding allocation (W is one global number;
any cap between formula and 0 would be invented, and 0 would kill legitimate
salary refunds), so the fix surfaces the ambiguity instead of guessing:
(a) engine returns mixedExcessWithholding (>0 only when mixed + excess) and a
CPR-verification sentence in the note; refund formula unchanged (final-first
default, now explicit); (b) filing-summary derives the same field from stored
lines + scalars (NO new DB column); (c) review step shows an amber warning
with the amount under the final-tax paragraph; (d) suite pins: Probe-3
replica (bank 1M + salary 500k, W 300k) asserts refund 100k + flagged 100k +
note mentions CPRs, pure-assessable and all-final excess assert flag 0.
Exact per-route allocation stays a P2 feature (needs CPR-section inputs).
Packet PDF untouched (prints no breakdown; still "snapshot for user review").
Files: lib/tax/tax-calculation.ts, app/actions/filing-summary.ts,
components/tax/filing/wizard-review-step.tsx,
scripts/verify-ty2026-tax-calculation.cjs, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + 15/15 offline suites (tax-calculation 172 assertions).

## §30 Combined-slab line identity (other-chat P0 #4, 2026-09-05)

Report §5: when two assessable progressive routes (their Probe 5: salary 3M +
rent 3M) priced jointly on the clause-1 slab, the receipt borrowed the first
source's identity plus its rule ID — "salary 6M / 149_SALARY_SLAB", rent
invisible. The report asked for one joint-slab line with named components.

Fix: the engine emits route `"combined_slab"` ("combined slab") with a
structured `combinedRoutes: [{ route, income }]` list; action persists it in
detailsJson (free-form — no migration); summary maps it through; review UI
prints "Combined slab — Salary 3,000,000 + Property rent 3,000,000". Probe 5
replica pinned: one line, income 6,000,000, taxDue 1,790,000. Per-route rule IDs
stay impossible by construction (one computation); the components list is the
traceability record instead. Deliberately NOT in ROUTE_ORDER (that map only
orders ledger inputs) and NOT in the portal map (source-route enums only).
Caught during implementation: ROUTE_RATE_SHAPES (Record over TaxRouteKey) also
needed the new key, and the review step uses its own local TaxBreakdownLine
duplicate (config's export feeds wizard props — both now carry the field).
Files: lib/tax/tax-calculation.ts, app/actions/tax-calculation.ts,
app/actions/filing-summary.ts, components/tax/filing/config/filing-wizard-config.ts,
components/tax/filing/wizard-review-step.tsx,
scripts/verify-ty2026-tax-calculation.cjs, NEEDS_RULES_IMPLEMENTATION.md.
Verified: tsc clean + offline suites green (tax-calculation 178 assertions).

## §31 #2 law verification (Ordinance amended to 31.07.2025, 2026-09-05)

User chose law_first. All verified against reference/ITO-2025.pdf (persisted
workspace copy of the FBR manual, 804pp):
(a) 153(3) = MINIMUM tax on (1)+(2) (FA2019 final->minimum); only carve-outs
are goods to manufacturer-co/listed public co (not minimum) and contracts to
listed public co (adjustable). The 153(6)-final text is pre-2011 repealed law
(FA2011-substitution footnote quote) — dead. S.169 final list has no 153
(removed FA2020). E-commerce 153(2A) (FA2025): treatment unstated -> adjustable
default (minor interpretive).
(b) Rental: Division VIA block omitted FA2021 -> individual/AOP rental is NTR
slab (engine combining lawful); 15A applies to "person" (FA2021) -> full
deduction list (a) repairs 1/5, (b) insurance, (c) local taxes, (d) ground
rent, (e) mortgage profit, (f) HBFC/bank share, (g) mortgage interest,
(h) admin/collection max 4% (FA2020 six->four), (i) legal, (j) irrecoverable
rent. Company-rental 15%-flat has NO Ordinance basis found -> separate ticket.
(c) S.113: 1.25% general (Div IX), individuals/AOPs only at turnover >=100M
(TY2017+). Below that N/A.
Design consequence: 153 receipts -> max(153-min on gross, NTR slab on net);
non-153 business -> pure NTR net; rental -> 15A net then slab. Needs per-route
expense capture (pipeline gap: action reads only INCOME categories).
