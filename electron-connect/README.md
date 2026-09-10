# TaxRocket Portal Agent - Electron Desktop Agent

This is the trusted desktop agent for FBR IRIS filing as described in `worker.md`.

## Architecture (from worker.md)

- **Main Process** (`main.js`): Creates BrowserWindow with persistent partition `persist:fbr-iris-{partitionKey}`, handles deep link `taxrocket-connect://`, localhost bridge `127.0.0.1:37219`, safeStorage for device token
- **Portal Agent** (`portal-agent.js`): Polls backend `/api/local-agent/jobs/next`, fetches context with portalFieldMap, fills IRIS fields using selectors, handles pause points (OTP, captcha, PIN, PSID, final review), captures screenshots
- **Selector Bundle** (`fbr-agent-config.ts`): DOM selectors for IRIS 2.0 Angular vs Classic PrimeFaces - can be updated without redeploy via DB

## Dev

```bash
cd electron-connect
npm install
npm run dev
```

## Build

```bash
npm run dist:win
# Output: dist/Tax Rocket Portal Agent Setup.exe
```

## Upload to GCS

```bash
npm run desktop-installer:upload
# Requires GCS_BUCKET_NAME, GOOGLE_APPLICATION_CREDENTIALS
```

## Flow

1. User in web app clicks "Create Desktop Session" -> gets launchToken + deep link
2. Web triggers `taxrocket-connect://connect?token=xxx&partition=yyy`
3. Electron main.js catches deep link, extracts token, calls `/api/fbr-connect/desktop/register`
4. Electron stores token via safeStorage (encrypted)
5. User logs into IRIS locally in Electron window
6. Electron calls `/api/fbr-connect/desktop/ready`
7. Electron polls `/api/local-agent/jobs/next` every 3s
8. When job found, fetches `/api/local-agent/jobs/{id}/context` -> gets portalFieldMap with IRIS codes (1000, 2001, 500312, 64150301 etc)
9. Fills IRIS fields, captures screenshots, pauses at gates (OTP etc) - sensitive data never leaves local
10. Reports status via `/api/local-agent/jobs/{id}/status`

## Required from Client

- GCS bucket for installer hosting (or use local)
- IRIS selectors for real portal (1000, 2001, 500312, 64020004, 64150301, 64151101 etc)
- Mock IRIS pages for testing (if available from old repo)
- Windows code signing cert for production

## Known Issues from worker.md

- Endpoint still named `/api/downloads/dld-connection/windows` but app is `Tax Rocket Portal Agent` - both endpoints now support backward compat
- Classic pause actions `classic_final_review` and `classic_pin_entry` normalized to `final_review` and `pin_required` in backend
- `fbr-connect-client.tsx` was not mounted - FIXED in Phase 1

## New-return setup dialog (TY2026+)

IRIS opens a modal titled "Normal Return (Ind/AOP/COY)" with a prefilled Person box and a Tax
Period box. The agent recognises that caption (`Tax Year`, `Period` or `Tax Period` + exactly one
`Continue`/`Accept and Continue`) and clicks Continue, because nothing is left for a human to
answer. It refuses and leaves a Retry checkpoint when any editable box is still empty, when a
4-digit period names a year other than the packet's, or when the dialog contains a
password/one-time-code field. It never auto-answers the residency question and never touches
Create/Save/Submit.

## Env Vars

```
# THE switch for touching the real portal. Read once per job (main.js:getRealAutofillMode).
#   off  (unset) — navigation only; the agent never resolves or writes a field
#   dry          — locates every IRIS target and reports what it WOULD write; writes nothing
#   live (or 1/true/on/yes) — actually writes, and only into cells whose column header
#                             and section structure were verified by the section tour
TAXROCKET_REAL_AUTOFILL=dry
```

The mode is echoed in every autofill log line (`real_autofill_start`), and a job that
filled 0 fields is reported as such — do not treat `dry` as "the filing worked".

`live` here is only half the switch. The web app decides the other half
(`TAXROCKET_ALLOW_LIVE_FILING`), and this process reads no `.env` at all — exporting the variable
in the shell that launches `npm run dev` is what counts. When the deployment has not opted in, the
agent says so in the job log and runs the job as `dry`. This is not a bug to work around: see
"Two keys are needed…" in the repository README.

One more thing can downgrade it: `taxAutomationConfig.livePilot.automaticFilingEnabled`
is a **deployment kill switch** (`main.js:resolveAutofillMode`). When it is explicitly
`false`, a `live` request runs as `dry` and the job log says so. It never *enables*
writes, and when the field is absent or null the env var decides alone.

Two safety rails are deliberate and should stay:
- **Derived cells are never written.** IRIS computes `Total Income`, `Subject to Final
  Tax`, `Subject to Exemption` and `Subject to Normal Tax` itself and renders them
  `disabled`; only the entered column may be filled.
- **A guessed cell is never written in `live`.** If a column can only be located by
  position (`position_fallback` / `sole_editable`), the field is refused as
  `unverified_target`. Set `payload.allowUnverifiedTargets` only for a supervised one-off.

```
FBR_USE_MOCK_IRIS=false
FBR_IRIS_LOGIN_URL=https://iris.fbr.gov.pk/
FBR_IRIS_READY_SELECTOR=body
FBR_IRIS_READY_URL_PATTERN=iris.fbr.gov.pk
FBR_IRIS_HOST_ALLOWLIST=iris.fbr.gov.pk
FBR_IRIS_DRY_RUN_URL=
FBR_IRIS_REVIEW_GATE_SELECTOR=
FBR_IRIS_FINAL_SUBMIT_SELECTOR=
GCS_BUCKET_NAME=
USE_GCS=false
NEXTAUTH_URL=http://localhost:3000
```
