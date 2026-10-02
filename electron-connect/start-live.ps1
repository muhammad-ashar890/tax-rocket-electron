# Explicit opt-in launcher. Normal `npm run dev` remains live-autofill OFF.
# While this Electron instance is open, each eligible queued job can run in live
# mode; close the agent after the intended supervised test.
$ErrorActionPreference = "Stop"
$previousMode = $env:TAXROCKET_REAL_AUTOFILL
$previousWealth = $env:TAXROCKET_WEALTH_AUTOFILL
$previousEmployer = $env:TAXROCKET_EMPLOYER_AUTOFILL
$previousLocation = Get-Location
$exitCode = 0

try {
  Set-Location -LiteralPath $PSScriptRoot
  $env:TAXROCKET_REAL_AUTOFILL = "live"
  # Wealth Statement modals (expenses, 7098, bank IBAN). Remove this line to keep
  # the Wealth figures "prepared, not entered".
  $env:TAXROCKET_WEALTH_AUTOFILL = "on"
  # Employer Details on the Salary page (adds employers by exact registered name).
  # Remove this line to keep employers "prepared, not added".
  $env:TAXROCKET_EMPLOYER_AUTOFILL = "on"
  npm run dev
  $exitCode = $LASTEXITCODE
} finally {
  if ([string]::IsNullOrEmpty($previousMode)) {
    Remove-Item Env:TAXROCKET_REAL_AUTOFILL -ErrorAction SilentlyContinue
  } else {
    $env:TAXROCKET_REAL_AUTOFILL = $previousMode
  }
  if ([string]::IsNullOrEmpty($previousWealth)) {
    Remove-Item Env:TAXROCKET_WEALTH_AUTOFILL -ErrorAction SilentlyContinue
  } else {
    $env:TAXROCKET_WEALTH_AUTOFILL = $previousWealth
  }
  if ([string]::IsNullOrEmpty($previousEmployer)) {
    Remove-Item Env:TAXROCKET_EMPLOYER_AUTOFILL -ErrorAction SilentlyContinue
  } else {
    $env:TAXROCKET_EMPLOYER_AUTOFILL = $previousEmployer
  }
  Set-Location -LiteralPath $previousLocation
}

exit $exitCode
