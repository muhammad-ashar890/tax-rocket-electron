# TaxRocket — Current Next Steps

**Current focus:** complete and test the **Salary-only** filing flow first.

**Date:** 2026-09-11

## Current decision

For the current testing round, only the Salary route is in scope. The Salary portal coverage is complete enough for a controlled supervised filing review in the real FBR portal. Property and other income sources remain paused and must not be silently included.

This does **not** mean that a return has been filed with FBR. Save, Submit, Calculate, payment, and other filing controls remain protected.

## Salary status: complete for testing

Employment → Salary has an authoritative capture contract covering the row codes, headers, and editable/computed cells.

Employment → Tax Deductions also has an authoritative capture contract, including certificate-control auditing.

### Salary page

| Row | Description | Captured state |
|---|---|---|
| `1000` | Income from Salary | Computed/read-only |
| `1009` | Pay, Wages or Other Remuneration | Writable captured cell |
| `1008` | Pension / Annuity u/s 12(2)(f) | Writable captured cells |
| `1010` | Arrears of Salary | Writable captured cells |
| `1049` | Allowances | Writable captured cell |
| `1059` | Expenditure Reimbursement | Writable captured cell |
| `1089` | Value of Perquisites | Writable captured cells |
| `1099` | Profits in Lieu of or in Addition to Pay, Wages or Other Remuneration | Writable captured cells |

The engine aggregates repeated salary ledger entries into the appropriate IRIS cell instead of repeatedly overwriting the same row.

### Employment → Tax Deductions

The three captured groups and all expected rows are covered:

- Adjustable Tax: `999909`, `64020004`, `64020005`
- Final Tax: `999910`, `64210051`, `64020007`
- Average Tax: `999911`, `64210054`, `64210056`

Summary rows are computed/read-only. Verified line rows are targeted only through the captured writable cells.

### Salary certificate handling

A salary certificate amount, when explicitly mapped from the approved packet, goes to:

```text
Employment → Tax Deductions
Row: 64020004 — Salary of Employees u/s 149
Column: Tax Deducted
```

The agent does not guess a salary certificate from a generic hidden document input. The three global document inputs remain separate document controls unless the user explicitly maps the document source.

## Recommended test now

### 1. Run offline checks

From the project directory:

```bash
cd /home/user/tax-rocket-new
npm install
npx prisma generate
npm run verify:employment-captures
npm run verify:portal-field-map
npm run verify:iris-row-filler
npx tsc --noEmit
```

These checks do not access FBR and do not submit anything.

### 2. Connect to the real FBR portal

Start the web app, download and install the TaxRocket Portal Agent, and connect it to the real FBR portal:

```bash
npm run dev
```

The Salary-only test should use:

- Tax Year 2026
- The user's actual taxpayer identity
- An explicitly selected residency status: `Resident` or `Non-Resident`
- Only the Salary income source
- The user's actual salary documents/ledger entries

Do not let the agent infer residency or add another income source.

### 3. Expected Salary test result

During the supervised Salary review:

1. The approved packet should contain Salary fields only.
2. Repeated salary entries should be aggregated into the captured Salary rows.
3. The FBR window should open Employment → Salary before entering Salary fields.
4. Salary Tax Deductions should target only captured writable cells.
5. Computed rows should remain unchanged and be reported, not written.
6. No Property fields should be queued.
7. No Save, Submit, Calculate, payment, upload, or final filing action should occur.

A successful review at this stage means the Salary route is ready for the taxpayer to review; it does not mean that FBR has received a return.

## Current blocked / remaining work

### Property

The Property work is audited structurally, but rent-entry mapping is still held because the supplied capture has no selected property.

Confirmed current state:

- Property → Receipts/Deductions rows `2000`, `2029`, `2001`, `2002`, `2003`, `2004`, `2005`, `2099`, `2031`
- `2001` Rent Received and `2031` Repairs are disabled before property selection
- Property → Tax Deductions row `64080001` is proven writable
- `999912` Adjustable Tax is computed/read-only
- The Select Property popup contains no property record

Next Property evidence requires a real property selected by the user. Do not create a dummy property. After selection, capture the complete Property Receipts/Deductions HTML so `2001` and `2031` can be re-audited.

### Other routes still not complete

These remain outside the current Salary-only test:

- Other Sources
- Business
- Capital Gain
- Foreign Sources/Agriculture
- Wealth Statement / reconciliation
- Full non-resident filing route
- Additional Property deduction source mapping for rows `2002`–`2005`
- Final FBR submission/payment behavior

No mapping should be invented for these routes.

## Safety rules for this testing round

- Select residency explicitly; never assume Resident.
- Use only the intended Salary income source.
- Do not add a placeholder Property.
- Do not click Save, Submit, Calculate, payment, or other filing controls.
- Use the real FBR portal only. The existing deployment/agent gate still controls whether approved Salary amounts may be entered.

## Relevant contracts and tests

- `lib/tax/iris-employment-capture.ts`
- `lib/tax/iris-property-capture.ts`
- `lib/tax/portal-row-evidence.ts`
- `scripts/verify-employment-captures.cjs`
- `scripts/verify-property-capture.cjs`
- `scripts/verify-portal-field-map.cjs`
- `scripts/verify-iris-row-filler.cjs`
- `electron-connect/iris-navigation.js`
- `electron-connect/iris-row-filler.js`
