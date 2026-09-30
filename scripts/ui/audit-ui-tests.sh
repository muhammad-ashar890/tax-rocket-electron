#!/usr/bin/env bash
# Mutation audit for the UI walkthrough suites.
#
# A passing test proves nothing on its own. This script breaks the code on
# purpose, one defect at a time, and asserts the UI suite FAILS. If a mutation
# lands and the suite still passes, that check is decorative and is reported.
#
# Every mutation is reverted immediately afterwards.
set -uo pipefail
cd "$(dirname "$0")/../.."

PASS=0
FAIL=0
declare -a FAILED

run_suite() {
  node "scripts/ui/$1" >/tmp/ui-audit-out.txt 2>&1
  echo $?
}

# mutate <name> <suite> <file> <search> <replace>
mutate() {
  local name="$1" suite="$2" file="$3" search="$4" replace="$5"
  cp "$file" /tmp/ui-audit-backup

  if ! grep -qF -- "$search" "$file"; then
    echo "  LAND FAIL  $name  (anchor not found -- mutation never applied)"
    FAILED+=("LAND FAIL: $name")
    FAIL=$((FAIL + 1))
    rm -f /tmp/ui-audit-backup
    return
  fi

  python3 - "$file" "$search" "$replace" <<'PY'
import sys
path, search, replace = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
assert search in src
open(path, "w").write(src.replace(search, replace, 1))
PY

  local rc
  rc=$(run_suite "$suite")
  cp /tmp/ui-audit-backup "$file"
  rm -f /tmp/ui-audit-backup

  if [ "$rc" != "0" ]; then
    echo "  caught     $name"
    PASS=$((PASS + 1))
  else
    echo "  NOT CAUGHT $name"
    FAILED+=("NOT CAUGHT: $name")
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Mutation audit of the UI walkthrough suites ==="
echo ""
echo "Route protection:"
mutate "middleware stops protecting /tax" \
  verify-ui-01-auth.cjs middleware.ts \
  'matcher: ["/tax/:path*"]' 'matcher: ["/never-matches-anything/:path*"]'

echo ""
echo "Tax engine (the numbers on screen):"
# The salary surcharge lives in the catalog, not the engine, and the bank-profit
# rows are table-driven -- grep will not find a composed rule id.
mutate "salary surcharge 9% -> 10%" \
  verify-ui-03-calculation.cjs lib/tax/rules/ty2026/catalog.ts \
  'surcharge: { percent: 9, basis: "CALCULATED_TAX" }' \
  'surcharge: { percent: 10, basis: "CALCULATED_TAX" }'
mutate "surcharge charged on income instead of calculated tax" \
  verify-ui-03-calculation.cjs lib/tax/rules/ty2026/catalog.ts \
  'surcharge: { percent: 9, basis: "CALCULATED_TAX" }' \
  'surcharge: { percent: 9, basis: "TAXABLE_INCOME" }'
mutate "bank profit deposit ATL 20% -> 21%" \
  verify-ui-03-calculation.cjs lib/tax/rules/ty2026/catalog.ts \
  '["BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "Bank or financial-institution account/deposit", 20, 40]' \
  '["BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "Bank or financial-institution account/deposit", 21, 40]'
mutate "bank profit Non-ATL 40% -> 40 assumed as double of 20" \
  verify-ui-03-calculation.cjs lib/tax/rules/ty2026/catalog.ts \
  '["BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "Bank or financial-institution account/deposit", 20, 40]' \
  '["BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "Bank or financial-institution account/deposit", 20, 35]'
mutate "dividend bonus shares ATL 10% -> 11%" \
  verify-ui-03-calculation.cjs lib/tax/rules/ty2026/catalog.ts \
  'atl: percent(10, "VALUE_OF_BONUS_SHARES")' \
  'atl: percent(11, "VALUE_OF_BONUS_SHARES")'
mutate "dividend bonus shares Non-ATL 20% -> 25%" \
  verify-ui-03-calculation.cjs lib/tax/rules/ty2026/catalog.ts \
  'nonAtl: percent(20, "VALUE_OF_BONUS_SHARES")' \
  'nonAtl: percent(25, "VALUE_OF_BONUS_SHARES")'

echo ""
echo "Money precision (Decimal boundary):"
mutate "sumMoney adds in float instead of Decimal" \
  verify-ui-03-calculation.cjs lib/money.ts \
  'export function sumMoney' 'export function sumMoneyRenamedByMutation'

echo ""
echo "Security -- the sequence gates:"
mutate "Mizan gate accepts a 0.01 gap again" \
  verify-ui-04-security.cjs lib/tax/filing-status.ts \
  'toMoneyAmount(reconciliationGap) === 0' \
  'Math.abs(toMoneyAmount(reconciliationGap)) <= 0.01'
mutate "document route drops the ownership filter" \
  verify-ui-04-security.cjs "app/api/documents/[id]/route.ts" \
  '      id: params.id,
      userId: user.id,' \
  '      id: params.id,'
mutate "stored content type is echoed back unchecked" \
  verify-ui-04-security.cjs lib/safe-file-types.ts \
  'return SERVABLE_MIME_TYPES.has(normalized)
    ? normalized
    : FALLBACK_BINARY_MIME_TYPE;' \
  'return normalized || FALLBACK_BINARY_MIME_TYPE;'
mutate "PDFs are allowed to render inline" \
  verify-ui-04-security.cjs lib/safe-file-types.ts \
  'mimeType === "image/jpeg" ||' \
  'mimeType === "application/pdf" || mimeType === "image/jpeg" ||'
mutate "SVG is added to the avatar allow-list" \
  verify-ui-04-security.cjs lib/safe-file-types.ts \
  'export const AVATAR_MIME_TYPES = new Set([
  "image/jpeg",' \
  'export const AVATAR_MIME_TYPES = new Set([
  "image/svg+xml",
  "image/jpeg",'

echo ""
echo "=================================================="
echo "  caught:     $PASS"
echo "  not caught: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  for f in "${FAILED[@]}"; do echo "  $f"; done
  exit 1
fi
echo "  ALL MUTATIONS CAUGHT"
