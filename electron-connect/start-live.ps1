# Explicit opt-in launcher. Normal `npm run dev` remains live-autofill OFF.
# While this Electron instance is open, each eligible queued job can run in live
# mode; close the agent after the intended supervised test.
$ErrorActionPreference = "Stop"
$previousMode = $env:TAXROCKET_REAL_AUTOFILL
$previousLocation = Get-Location
$exitCode = 0

try {
  Set-Location -LiteralPath $PSScriptRoot
  $env:TAXROCKET_REAL_AUTOFILL = "live"
  npm run dev
  $exitCode = $LASTEXITCODE
} finally {
  if ([string]::IsNullOrEmpty($previousMode)) {
    Remove-Item Env:TAXROCKET_REAL_AUTOFILL -ErrorAction SilentlyContinue
  } else {
    $env:TAXROCKET_REAL_AUTOFILL = $previousMode
  }
  Set-Location -LiteralPath $previousLocation
}

exit $exitCode
