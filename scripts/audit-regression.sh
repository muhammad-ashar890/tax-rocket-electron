#!/usr/bin/env bash
#
# Regression audit for the Phase 5 money migration.
#
# The verify suites prove the code passes its own tests. This proves the tests
# would still FAIL if the tax rules were wrong -- which is the thing that
# actually matters while columns are being converted from Float to Decimal.
#
# Each mutation below breaks one rule that an earlier phase established. Every
# one of them MUST be caught. A mutation that is not caught means a real tax
# rule can now be broken silently.
#
# Usage:  bash scripts/audit-regression.sh
#
# Exit code 0 = every mutation was caught. Non-zero = at least one survived,
# or a mutation failed to apply (which would make the result meaningless).

set -uo pipefail
cd "$(dirname "$0")/.."

BACKUP="$(mktemp -d)"
trap 'restore; rm -rf "$BACKUP"' EXIT INT TERM

FILES=(
  "lib/tax/rules/ty2026/catalog.ts"
  "lib/tax/tax-calculation.ts"
  "app/actions/tax-calculation.ts"
  "lib/tax/reconciliation-calculation.ts"
  "app/actions/bank-classification.ts"
  "app/actions/bank-statements.ts"
  "app/actions/bank-parser.ts"
  "lib/tax/bank-transfer-matching.ts"
  "lib/tax/bank-classification-rules.ts"
  "lib/money.ts"
  "app/actions/filing-summary.ts"
  "app/actions/tax-calculation.ts"
  "lib/tax/filing-status.ts"
  "app/actions/filing-summary.ts"
  "app/actions/packet.ts"
  "lib/sales-tax/compute-return.ts"
  "lib/sales-tax/money.ts"
  "lib/sales-tax/invoice-checks.ts"
  "lib/sales-tax/template-reader.ts"
  "lib/sales-tax/rules/fbr-goods/catalog.ts"
  "lib/sales-tax/rules/fbr-goods/penalties.ts"
  "lib/tax/filing-draft-identity.ts"
  "app/actions/filing.ts"
  "components/tax/filing/filing-wizard.tsx"
  "app/actions/sales-tax.ts"
  "lib/sales-tax/profile.ts"
  "components/tax/sales-tax/sales-tax-wizard.tsx"
  "components/tax/sales-tax/invoice-steps.tsx"
  "lib/sales-tax/figures.ts"
  "lib/sales-tax/estimate.ts"
  "components/tax/sales-tax/review-step.tsx"
  "lib/sales-tax/workbook.ts"
  "lib/sales-tax/template-reader.ts"
  "lib/sales-tax/problems.ts"
  "components/tax/dashboard-sidebar.tsx"
  "components/tax/filing/wizard-setup-step.tsx"
)

save()    { for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done; }
restore() { for f in "${FILES[@]}"; do [ -f "$BACKUP/$f" ] && cp "$BACKUP/$f" "$f"; done; }

save

PASS=0
FAIL=0
LANDFAIL=0
FAILED_NAMES=()

# Apply one literal string replacement, refusing to continue if it did not
# land. A mutation that does not land looks exactly like a caught mutation,
# so this distinction is the difference between a real result and a lie.
apply_mutation() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as handle:
    source = handle.read()
if old not in source:
    sys.exit(9)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(source.replace(old, new, 1))
PY
}

check() {
  local label="$1" file="$2" old="$3" new="$4"
  restore

  if ! apply_mutation "$file" "$old" "$new"; then
    printf '  %-52s LAND FAIL (anchor not found)\n' "$label"
    LANDFAIL=$((LANDFAIL + 1))
    FAILED_NAMES+=("$label (anchor not found)")
    return
  fi

  if npm run verify:all >/dev/null 2>&1; then
    printf '  %-52s NOT CAUGHT\n' "$label"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$label (survived)")
  else
    printf '  %-52s caught\n' "$label"
    PASS=$((PASS + 1))
  fi
}

echo "Regression audit - breaking established rules on purpose"
echo

echo "Tax rules (Phases 2 and 4):"
check "P2  salary surcharge 9% -> 10%" \
  "lib/tax/rules/ty2026/catalog.ts" \
  'surcharge: { percent: 9, basis: "CALCULATED_TAX" }' \
  'surcharge: { percent: 10, basis: "CALCULATED_TAX" }'

check "P2  surcharge charged on income, not on tax" \
  "lib/tax/rules/ty2026/catalog.ts" \
  'surcharge: { percent: 9, basis: "CALCULATED_TAX" }' \
  'surcharge: { percent: 9, basis: "TAXABLE_INCOME" }'

check "P4A services IT/ITES 4% -> 5%" \
  "lib/tax/rules/ty2026/catalog.ts" \
  '["1B-SERVICE-IT-ITES", "IT and IT-enabled services", 4, 8, 6,' \
  '["1B-SERVICE-IT-ITES", "IT and IT-enabled services", 5, 8, 6,'

check "P4B business contract 7.5% -> 7.6%" \
  "lib/tax/rules/ty2026/catalog.ts" \
  'percent(7.5' \
  'percent(7.6'

check "P4C dividend bonus shares 10% -> 11%" \
  "lib/tax/rules/ty2026/catalog.ts" \
  'atl: percent(10, "VALUE_OF_BONUS_SHARES")' \
  'atl: percent(11, "VALUE_OF_BONUS_SHARES")'

check "P4D section 152 sub-section (1) 15% -> 16%" \
  "lib/tax/rules/ty2026/catalog.ts" \
  '["1", "Sub-section (1)", 15],' \
  '["1", "Sub-section (1)", 16],'

echo
echo "Engine behaviour:"
check "P4C amount-band guard removed" \
  "lib/tax/tax-calculation.ts" \
  'matchesAmountCondition(candidate, input.field, input.amount),' \
  'true,'

check "P4B business dropped from the remainder" \
  "app/actions/tax-calculation.ts" \
  '        businessIncome -' \
  ''

echo
echo "Money precision (Phase 5):"
# The 5-C-1 mutation that removed toMoneyNumber from the balance mapping used
# to be caught here. It no longer is, and that is an improvement rather than a
# regression: those totals now go through sumMoney, which coerces a Decimal
# itself, so dropping the earlier conversion no longer changes the answer. The
# hazard was removed rather than merely detected, so there is nothing left to
# mutate. The equivalent protection is now the sumMoney mutations below.

check "5C1 non-numeric total guard disabled" \
  "lib/tax/reconciliation-calculation.ts" \
  'if (typeof value !== "number" || !Number.isFinite(value)) {' \
  'if (false) {'

check "5C1 a total dropped from that guard" \
  "lib/tax/reconciliation-calculation.ts" \
  '    cashMovement,
    totalLiabilities,' \
  '    totalLiabilities,'

check "5C1 Decimal compared with === again" \
  "app/actions/bank-classification.ts" \
  'toMoneyNumber(statement.openingBalance) ===' \
  '(statement.openingBalance as unknown as number) ==='

check "5C1 balance sent to the browser unconverted" \
  "app/actions/bank-statements.ts" \
  '      closingBalance: toMoneyNumber(statement.closingBalance),' \
  ''

check "5C2 credit/debit direction falsy-tested again" \
  "lib/tax/bank-classification-rules.ts" \
  '  const hasCredit = creditAmount > 0 && debitAmount === 0;
  const hasDebit = debitAmount > 0 && creditAmount === 0;' \
  '  const hasCredit = (transaction.credit ?? 0) > 0 && !(transaction.debit ?? 0);
  const hasDebit = (transaction.debit ?? 0) > 0 && !(transaction.credit ?? 0);'

check "5C2 opening balance derived in floating point" \
  "lib/money.ts" \
  '  return toDecimal(firstBalance)
    .minus(toDecimal(firstCredit))
    .plus(toDecimal(firstDebit))
    .toNumber();' \
  '  return (
    toMoneyAmount(firstBalance) -
    toMoneyAmount(firstCredit) +
    toMoneyAmount(firstDebit)
  );'

# Note on two mutations that are deliberately NOT in this list.
#
# Replacing toMoneyAmount with a raw `?? 0` in bank-transfer-matching, and
# hand-inlining the parser's derivation, were both tried. Neither changes
# behaviour: Decimal implements the comparison and subtraction operators
# correctly, so `>`, `<=` and `-` all still give the right answer. They were
# recorded as "NOT CAUGHT" until the arithmetic was actually run, which showed
# there was no defect to catch. A mutation that does not break anything cannot
# be caught, and listing it here would report a permanent false failure.
#
# The operators that genuinely misbehave are `+` (concatenates) and truthiness
# (`Decimal(0)` is truthy). Those are the ones mutated above and below.

check "5C2 opening balance returns the Decimal itself" \
  "lib/money.ts" \
  '  return toDecimal(firstBalance)
    .minus(toDecimal(firstCredit))
    .plus(toDecimal(firstDebit))
    .toNumber();' \
  '  return toDecimal(firstBalance)
    .minus(toDecimal(firstCredit))
    .plus(toDecimal(firstDebit)) as unknown as number;'

check "5C2 toMoneyAmount stops handling null" \
  "lib/money.ts" \
  'if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}' \
  'return Number(value);
}'

check "5C2 transaction amounts sent to the browser raw" \
  "lib/tax/reconciliation-calculation.ts" \
  '      debit: toMoneyNumberOrNull(transaction.debit),' \
  '      debit: transaction.debit as unknown as number,'

check "5C3A sumMoney converts before adding" \
  "lib/money.ts" \
  '      (total, value) => total.plus(toDecimal(value)),' \
  '      (total, value) => new Prisma.Decimal(total.toNumber() + Number(value ?? 0)),'

check "5C3A netMoney converts before adding" \
  "lib/money.ts" \
  '        subtract ? total.minus(toDecimal(value)) : total.plus(toDecimal(value)),' \
  '        new Prisma.Decimal(subtract ? total.toNumber() - Number(value ?? 0) : total.toNumber() + Number(value ?? 0)),'

check "5C3A reconciliation totals summed with +" \
  "lib/tax/reconciliation-calculation.ts" \
  '  const totalIncome = sumEntries("INCOME");' \
  '  const totalIncome = ledgerEntries.filter((e) => e.entryType === "INCOME").reduce((t, e) => t + Number(e.amount), 0);'

check "5C3A the final gap combined in floating point" \
  "lib/tax/reconciliation-calculation.ts" \
  '  const gap = netMoney([
    { value: closingWealth },
    { value: openingWealth, subtract: true },
    { value: wealthMovement, subtract: true },
  ]);' \
  '  const gap = closingWealth - openingWealth - wealthMovement;'

check "5C3A wealth movement combined in floating point" \
  "lib/tax/reconciliation-calculation.ts" \
  '  const wealthMovement = netMoney([
    { value: totalIncome },
    { value: totalLiabilities },
    { value: totalExpenses, subtract: true },
    { value: totalAssets, subtract: true },
    { value: cashMovement, subtract: true },
    { value: otherAdjustments },
  ]);' \
  '  const wealthMovement =
    totalIncome + totalLiabilities - totalExpenses - totalAssets - cashMovement + otherAdjustments;'

check "5C3A adjustments netted in floating point" \
  "lib/tax/reconciliation-calculation.ts" \
  '  const otherAdjustments = netMoney(
    ledgerEntries' \
  '  const otherAdjustments = ((entries) =>
    entries.reduce(
      (total, e) =>
        e.category === "RECONCILIATION_ADJUSTMENT_OUTFLOW"
          ? total - Number(e.amount)
          : total + Number(e.amount),
      0,
    ))(
    ledgerEntries'

check "5C3A tax income summed in floating point" \
  "app/actions/tax-calculation.ts" \
  '    const totalIncome = sumMoney(
      entries
        .filter(
          (entry) =>
            entry.entryType === "INCOME" && !isGiftCategory(entry.category),
        )
        .map((entry) => entry.amount),
    );' \
  '    const totalIncome = entries
      .filter(
        (entry) =>
          entry.entryType === "INCOME" && !isGiftCategory(entry.category),
      )
      .reduce((total, entry) => total + Number(entry.amount), 0);'

check "5C3A filing summary totals summed with +" \
  "app/actions/filing-summary.ts" \
  '      income: totalFor("INCOME"),' \
  '      income: entries.filter((e) => e.entryType === "INCOME").reduce((t, e) => t + Number(e.amount), 0),'

echo
echo "Submission gate (Phase 5-D and 5-E):"
check "5E the paisa tolerance restored on the gate" \
  "lib/tax/filing-status.ts" \
  'reconciliationStatus === "RESOLVED" && toMoneyAmount(reconciliationGap) === 0' \
  'reconciliationStatus === "RESOLVED" && Math.abs(toMoneyAmount(reconciliationGap)) <= 0.01'

check "5E the gate stops converting its Decimal input" \
  "lib/tax/filing-status.ts" \
  'toMoneyAmount(reconciliationGap) === 0' \
  '(reconciliationGap as unknown as number) === 0'

check "5D draft money sent to the browser unconverted" \
  "app/actions/filing-summary.ts" \
  '        taxPayable: toMoneyNumberOrNull(currentDraft?.taxPayable),' \
  '        taxPayable: currentDraft?.taxPayable as unknown as number,'

check "5D the reconciliation gap sent unconverted" \
  "app/actions/filing-summary.ts" \
  '        reconciliationGap: toMoneyNumberOrNull(currentDraft?.reconciliationGap),' \
  '        reconciliationGap: currentDraft?.reconciliationGap as unknown as number,'

check "5D withheld tax compared as a raw Decimal" \
  "app/actions/tax-calculation.ts" \
  '      storedTaxWithheld: toMoneyAmount(draft.taxWithheld),' \
  '      storedTaxWithheld: (draft.taxWithheld ?? 0) as number,'

check "5F revision fingerprint hashes a raw Decimal balance" \
  "lib/tax/reconciliation-calculation.ts" \
  '          openingBalance: toMoneyNumber(statement.openingBalance),' \
  '          openingBalance: statement.openingBalance as unknown as number,'

check "5F revision fingerprint hashes a raw Decimal amount" \
  "lib/tax/reconciliation-calculation.ts" \
  '      amount: toMoneyNumber(entry.amount),
      source: entry.source,' \
  '      amount: entry.amount as unknown as number,
      source: entry.source,'

check "5F packet PDF formats a raw Decimal" \
  "app/actions/packet.ts" \
  '        ? `PKR ${toMoneyNumber(value).toLocaleString()}`' \
  '        ? `PKR ${value.toLocaleString()}`'

check "5F packet gap line formats a raw Decimal" \
  "app/actions/packet.ts" \
  '      `Reconciliation gap: PKR ${Math.abs(
        toMoneyAmount(snapshot.filing.reconciliationGap),
      ).toLocaleString()}`,' \
  '      `Reconciliation gap: PKR ${(snapshot.filing.reconciliationGap as unknown as number).toLocaleString()}`,'

echo
echo "Sales tax engine (FBR goods, Phase 1):"
check "ST  balance payable ignores tax already paid (Sr.37)" \
  "lib/sales-tax/compute-return.ts" \
  'const line37 = line35 - line36;' \
  'const line37 = line35 + line36;'

check "ST  input tax limit taken on the wrong base (Sr.25)" \
  "lib/sales-tax/compute-return.ts" \
  'percentOfFloor(line15, eightB.capPercent)' \
  'percentOfFloor(line17, eightB.capPercent)'

check "ST  capital goods placed inside the limit (Sr.25)" \
  "lib/sales-tax/compute-return.ts" \
  'Math.min(ordinaryInput, capAmount) + capitalInput,' \
  'Math.min(ordinaryInput + capitalInput, capAmount),'

check "ST  credit notes added instead of subtracted" \
  "lib/sales-tax/compute-return.ts" \
  'return documentType === "Credit Note" ? -1 : 1;' \
  'return 1;'

check "ST  standard rate 18% -> 17%" \
  "lib/sales-tax/rules/fbr-goods/catalog.ts" \
  'value: 0.18,' \
  'value: 0.17,'

check "ST  late return penalty Rs 50,000 -> Rs 10,000" \
  "lib/sales-tax/rules/fbr-goods/catalog.ts" \
  'value: 50000,' \
  'value: 10000,'

check "ST  tax rounding truncates instead of rounding" \
  "lib/sales-tax/money.ts" \
  'Math.floor((scaled + 5000) / 10000)' \
  'Math.floor(scaled / 10000)'

check "ST  invoice tax tolerance widened" \
  "lib/sales-tax/invoice-checks.ts" \
  'export const TAX_TOLERANCE_PAISA = 100;' \
  'export const TAX_TOLERANCE_PAISA = 100000;'

check "ST  per-day penalty window shortened" \
  "lib/sales-tax/rules/fbr-goods/penalties.ts" \
  'if (daysLate <= window) {' \
  'if (daysLate < window) {'

check "ST  template layout check switched off" \
  "lib/sales-tax/template-reader.ts" \
  '  if (!headerMatches(grid, reference)) {' \
  '  if (false) {'

echo
echo "Several filings per tax year:"
check "MF  an approved or filed draft can be overwritten" \
  "lib/tax/filing-draft-identity.ts" \
  '    .filter((draft) => !isProtectedFilingDraft(draft))
' \
  ''
check "MF  a completed real filing no longer protects a draft" \
  "lib/tax/filing-draft-identity.ts" \
  'connection.status === FILING_COMPLETED_STATUS ||' \
  'false ||'
check "MF  the explicit draft id is ignored by the server" \
  "app/actions/filing.ts" \
  '  const value = raw.trim();' \
  '  const value = "";'
check "MF  another user's draft id is accepted" \
  "app/actions/filing.ts" \
  '    if (!owned) throw new FilingDraftNotFoundError();' \
  '    if (!owned) return explicitDraftId;'
check "MF  the wizard stops sending the draft id" \
  "components/tax/filing/filing-wizard.tsx" \
  '    if (currentDraftId) formData.set("draftId", currentDraftId);' \
  ''

echo
echo "Sales Tax module shell (Phase 2A):"
check "SM  a month can be started for an authority outside the profile" \
  "app/actions/sales-tax.ts" \
  'if (!allowed.includes(authority as AuthorityCode)) {' \
  'if (false) {'
check "SM  a month that is not a draft can be deleted" \
  "app/actions/sales-tax.ts" \
  'if (filing.status !== STATUS_DRAFT) {' \
  'if (false) {'
check "SM  another user can open a month" \
  "app/actions/sales-tax.ts" \
  'where: { id: String(filingId ?? ""), userId },
        include: {' \
  'where: { id: String(filingId ?? "") },
        include: {'
check "SM  a month in the future can be started" \
  "lib/sales-tax/profile.ts" \
  '    period.year > currentYear ||
    (period.year === currentYear && period.month > currentMonth)' \
  '    false'
check "SM  a provincial board that is not built yet can be saved" \
  "lib/sales-tax/profile.ts" \
  'code: "SRB", name: "SRB (Sindh)", scope: "Sales tax on services", enabled: false' \
  'code: "SRB", name: "SRB (Sindh)", scope: "Sales tax on services", enabled: true'
check "SM  the sidebar loses the Sales Tax link" \
  "components/tax/dashboard-sidebar.tsx" \
  '  { href: "/tax/sales-tax", label: "Sales Tax", icon: Receipt },
' \
  ''
check "SM  the wizard offers the Sales Tax card again" \
  "components/tax/filing/wizard-setup-step.tsx" \
  'source.value !== "sales_tax_fed_withholding" ||' \
  'true ||'

check "SM  the wizard lets a return be created with a step still invalid" \
  "components/tax/sales-tax/sales-tax-wizard.tsx" \
  'disabled={submitting || !setupValid}' \
  'disabled={submitting}'
check "SM  the wizard starts the month before saving the business" \
  "components/tax/sales-tax/sales-tax-wizard.tsx" \
  '      const saved = await saveSalesTaxProfileAction({' \
  '      await startSalesTaxMonthAction({ authority: "FBR", year, month });
      const saved = await saveSalesTaxProfileAction({'
check "SM  the whole-profile check skips the authority check" \
  "lib/sales-tax/profile.ts" \
  '  const authorities = validateAuthoritySelection(input.authorities);
  if (authorities.ok === false) return { ok: false, error: authorities.error };' \
  '  const authorities = { ok: true as const, value: ["FBR" as AuthorityCode] };'
check "SM  the wizard lets a future month be picked" \
  "components/tax/sales-tax/sales-tax-wizard.tsx" \
  'disabled={future}' \
  'disabled={false}'

echo
echo "Sales Tax invoice upload (Phase 2B):"
check "SU  an upload for someone else's month is accepted" \
  "app/actions/sales-tax.ts" \
  '      prisma.salesTaxFiling.findFirst({
        where: { id: filingId, userId },
        select: { id: true, status: true, periodYear: true, periodMonth: true },
      }),
      prisma.salesTaxProfile.findUnique({ where: { userId } }),
    ]);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Files can only be changed while the month is a draft." };
    }
    if (!profile) {' \
  '      prisma.salesTaxFiling.findFirst({
        where: { id: filingId },
        select: { id: true, status: true, periodYear: true, periodMonth: true },
      }),
      prisma.salesTaxProfile.findUnique({ where: { userId } }),
    ]);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Files can only be changed while the month is a draft." };
    }
    if (!profile) {'
check "SU  a file that cannot be read is stored anyway" \
  "app/actions/sales-tax.ts" \
  'if (!stats || !stats.readable) {' \
  'if (!stats) {'
check "SU  the upload size limit is removed" \
  "app/actions/sales-tax.ts" \
  'if (file.size > MAX_UPLOAD_BYTES) {' \
  'if (false) {'
check "SU  a file with too many rows is accepted" \
  "lib/sales-tax/workbook.ts" \
  '      if (hasValue) tooLong = true;' \
  '      if (hasValue) tooLong = false;'
check "SU  merged header cells are no longer cleared" \
  "lib/sales-tax/workbook.ts" \
  'if (cell.isMerged && cell.master && cell.master.address !== cell.address) {' \
  'if (false) {'
check "SU  any blank header cell is accepted" \
  "lib/sales-tax/template-reader.ts" \
  '        normalizeHeader(cell(grid, rowIndex - 1, column)) ===
          normalizeHeader(expected[column])
      ) {
        continue;' \
  '        true
      ) {
        continue;'
check "SU  a template problem stops naming its file" \
  "lib/sales-tax/problems.ts" \
  'const merged: Params = { sheet, ...params,' \
  'const merged: Params = { ...params, sheet,'
check "SU  the wizard stops asking before removing a file" \
  "components/tax/sales-tax/invoice-steps.tsx" \
  'if (!window.confirm("Remove this file? You can upload it again later.")) return;' \
  ''

echo
echo "Sales Tax review and approval (Phase 3):"
check "SR  a return is approved without the tick" \
  "app/actions/sales-tax.ts" \
  'if (confirmed !== true) {' \
  'if (false) {'
check "SR  a return that cannot be estimated is approved" \
  "lib/sales-tax/estimate.ts" \
  'if (!input.result.canEstimate || input.result.balancePayable === null) {' \
  'if (false) {'
check "SR  an approval survives a changed file" \
  "lib/sales-tax/estimate.ts" \
  '    files: input.files,
    canEstimate:' \
  '    canEstimate:'
check "SR  an approval survives a changed figure" \
  "lib/sales-tax/estimate.ts" \
  '    figures: input.figures,
    files: input.files,
    canEstimate:' \
  '    files: input.files,
    canEstimate:'
check "SR  another user can approve or save figures" \
  "app/actions/sales-tax.ts" \
  'async function loadMonthForReview(userId: string, filingId: string) {
  const [filing, profile] = await Promise.all([
    prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId },' \
  'async function loadMonthForReview(userId: string, filingId: string) {
  const [filing, profile] = await Promise.all([
    prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? "") },'
check "SR  bad figures are stored" \
  "app/actions/sales-tax.ts" \
  'const checked = validateFiguresForm(form);
    if (checked.ok === false) return { success: false as const, error: checked.error };' \
  'const checked = validateFiguresForm(form) as { ok: true; value: ReturnFigures };'
check "SR  a month that is not a draft can be approved" \
  "app/actions/sales-tax.ts" \
  'if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Only a draft return can be approved." };' \
  'if (false) {
      return { success: false as const, error: "Only a draft return can be approved." };'
check "SR  an unregistered supplier row can be a fixed asset" \
  "lib/sales-tax/estimate.ts" \
  'if (row.sellerType !== "Registered") {
      return `Fixed assets' \
  'if (false) {
      return `Fixed assets'
check "SR  a negative amount is accepted" \
  "lib/sales-tax/figures.ts" \
  'if (paisa < 0) return { ok: false, error: `${label}: the amount cannot be negative.` };' \
  ''
check "SR  a stale approval is shown as current" \
  "app/actions/sales-tax.ts" \
  'current: isApprovalCurrent(filing.approvedPacket, { fingerprint }),' \
  'current: true,'
check "SR  the approve button works without the tick" \
  "components/tax/sales-tax/sales-tax-wizard.tsx" \
  '                      !reviewed ||
                      !review?.estimate.canEstimate' \
  '                      !review?.estimate.canEstimate'
check "SR  the review step opens before the earlier steps are done" \
  "components/tax/sales-tax/sales-tax-wizard.tsx" \
  'if (index >= FIGURES_STEP && index > furthest) return;' \
  ''
check "SR  the screen stops saying the figures are an estimate" \
  "components/tax/sales-tax/review-step.tsx" \
  'IRIS calculates the final amounts' \
  'the final amounts are shown here'

restore

echo
echo "-----------------------------------------------------------"
TOTAL=$((PASS + FAIL + LANDFAIL))
echo "caught ${PASS}/${TOTAL}"

if [ "$FAIL" -gt 0 ] || [ "$LANDFAIL" -gt 0 ]; then
  echo
  echo "PROBLEMS:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "  - ${name}"
  done
  echo
  if [ "$LANDFAIL" -gt 0 ]; then
    echo "An anchor was not found, so that mutation never reached the code."
    echo "It did not pass -- it did not run. Update the anchor in this script."
  fi
  if [ "$FAIL" -gt 0 ]; then
    echo "A surviving mutation means that rule can now be broken silently."
  fi
  exit 1
fi

echo "Every mutation was caught."
