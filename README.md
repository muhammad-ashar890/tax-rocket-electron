# TaxRocket

TaxRocket is a guided Pakistan tax-filing workspace built with Next.js. It supports taxpayer setup, document review, bank-statement reconciliation, ledger preparation, tax estimation, filing-packet approval, and a supervised connection to the real FBR IRIS portal.

> **Status:** Pilot. The tax engine currently implements **Tax Year 2026 only** (Finance Act 2025). The FBR step is a supervised local desktop handoff; it is not an FBR API submission.
>
> **Real FBR only:** the desktop agent connects to `https://iris.fbr.gov.pk/`. Mock IRIS pages are not used.

## Current FBR handoff scope

The current supervised handoff is deliberately limited to the verified areas needed for the Salary test:

- Salary income rows
- Salary withholding in **Tax Deductions → Adjustable Tax → Salary of Employees u/s 149** (`64020004`)

Optional, off by default: with `TAXROCKET_WEALTH_AUTOFILL=on` (and `TAXROCKET_REAL_AUTOFILL=live`) the agent also adds Wealth Statement rows through the IRIS modals — personal expenses (Reconciliation → `+ Expenses`), the tax-paid outflow `7098`, and bank accounts by IBAN (Personal Assets → `+ Assets`) — then types the packet amounts. In dry mode it only reports what it would add. The only buttons it presses are the `+` icons that open those dialogs, the tick-boxes inside them, and the dialog's own ADD/SAVE; it never presses the return's Save, Calculate or Submit, and never edits or deletes an existing row.

The agent does **not** automatically open or fill:

- Property
- Wealth Statement rows, unless the Wealth switch above is on
- Payments
- Computations
- Save, Submit, Calculate, payment, or other filing controls

The agent may enter only packet-approved values after the live row and column are verified. A missing row or unverified target pauses the job for review; it is never silently treated as success. The UI must not report a filing as finished when required handoff fields are skipped. A completed handoff still means **not saved and not submitted**.

Synthetic documents in `test-data/` are clearly labelled test data. They may be used to verify extraction and mapping, but they must never be treated as valid evidence for an actual FBR return.

## Technology

- Next.js 14.2.x, React 18, TypeScript, Tailwind CSS
- Prisma 5 with PostgreSQL
- NextAuth with Google OAuth
- Gemini AI for document and bank-data extraction/classification
- PDFKit for filing packet PDFs
- XLSX support for structured bank statements
- Playwright for browser test suites
- Electron 28 and electron-builder for the Windows desktop agent

## Main filing flow

1. Sign in with Google.
2. Complete taxpayer profile and filing setup for Tax Year 2026.
3. Upload and review required tax documents.
4. Extract and map document data.
5. Import or enter bank statements and transactions.
6. Maintain income, expense, asset, and liability ledger entries.
7. Resolve the TaxRocket wealth reconciliation gate.
8. Calculate a route-specific TY2026 estimate.
9. Review withholding duplicates and approve a versioned filing packet.
10. Connect the trusted desktop agent to the real FBR IRIS portal.
11. Complete OTP, CAPTCHA, PIN, or other sensitive steps locally.
12. Review the supervised Salary and Salary-withholding handoff. The agent does not Save, Submit, Calculate, or pay.

## Requirements

- **Node.js 20.x LTS**
- npm
- **PostgreSQL 16** running locally, with an empty `taxrocket` database
- Google OAuth application for login
- Gemini API key (optional; manual entry is available without it)
- Windows 10/11 x64 for building the Windows desktop installer

## Local web-app setup

From the repository root:

```bash
# 1. Clone the repository, then enter it
git clone https://github.com/muhammad-ashar890/tax-rocket-electron.git
cd tax-rocket-electron

# 2. Check Node.js
node --version        # should be v20.x
npm --version

# 3. Install web-app dependencies
npm install

# 4. Create .env in the repository root

# 5. Create the database once, with PostgreSQL running:
#    CREATE DATABASE taxrocket;

# 6. Generate Prisma Client and apply committed migrations
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status

# 7. Start the web app
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Use `prisma migrate deploy`, not `prisma migrate dev`, for the checked-in migration history. `migrate dev` tries to create migrations and requires a shadow database.

### Root `.env` template

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/taxrocket"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-output-of-openssl-rand-base64-32"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-3.5-flash"

# Required only for a supervised live-entry test.
# Keep false/unset for dry-run or navigation-only work.
# TAXROCKET_ALLOW_LIVE_FILING="true"
```

Generate the NextAuth secret with:

```bash
openssl rand -base64 32
```

Google Cloud Console must contain this local callback URL:

```text
http://localhost:3000/api/auth/callback/google
```

## Two-key live-entry safety gate

Writing approved values into the real FBR window requires both keys:

1. **Operator key:** set in the shell that launches the Electron desktop agent:
   `TAXROCKET_REAL_AUTOFILL=dry` or `TAXROCKET_REAL_AUTOFILL=live`.
2. **Deployment key:** set in the web-app/server environment:
   `TAXROCKET_ALLOW_LIVE_FILING=true`.

The Electron process does not read the web app's `.env` file. Set the operator variable in the shell that starts Electron.

### PowerShell

```powershell
# Read-only target discovery; no values are written
$env:TAXROCKET_REAL_AUTOFILL = "dry"
npm run dev
```

For the supervised synthetic Salary + Salary-withholding value-entry test:

```powershell
$env:TAXROCKET_REAL_AUTOFILL = "live"
npm run dev
```

The server must also have `TAXROCKET_ALLOW_LIVE_FILING=true`. If the deployment kill switch `taxAutomationConfig.livePilot.automaticFilingEnabled` is explicitly `false`, the agent downgrades to dry mode.

### Windows Command Prompt

```bat
set TAXROCKET_REAL_AUTOFILL=dry
npm run dev
```

Use `set TAXROCKET_REAL_AUTOFILL=live` only for the supervised value-entry test.

Even in live mode, the agent:

- writes only into verified Salary and Salary-withholding cells;
- never writes into derived/disabled cells;
- never guesses a row or column;
- never opens Property, Payments, or Computations automatically (Wealth only when `TAXROCKET_WEALTH_AUTOFILL=on`);
- never clicks Calculate, Save, Submit, payment, or other filing controls.

## Windows desktop agent

The Electron desktop agent is a separate application in `electron-connect/`. Close any running Electron process before installing, rebuilding, or replacing it.

### Run the desktop agent in development

From the repository root:

```bash
cd electron-connect
npm install
npm run dev
```

Equivalent command:

```bash
npx electron . --dev
```

To run the packaged entry point without building an installer:

```bash
npm start
```

The web app and desktop agent must run at the same time. The desktop agent uses the local bridge on `127.0.0.1:37219` and connects to the web app session.

### Build the Windows installer

Build on Windows 10/11 x64. Code signing is not required for this development installer; Windows SmartScreen may show a warning on first launch.

```bat
cd path\to\tax-rocket-electron\electron-connect
npm install
npm run dist:win
```

The first build downloads Electron and NSIS binaries and may take several minutes.

Output:

```text
electron-connect\dist\TaxRocket-Portal-Agent-Setup-1.0.0.exe
```

Install it by double-clicking the `.exe` file. The installer creates:

- Desktop shortcut: **Tax Rocket Portal Agent**
- Start Menu shortcut: **Tax Rocket Portal Agent**
- Deep-link protocol: `taxrocket-connect://`

The packaged app includes the synchronized build files:

- `main.js`
- `iris-navigation.js`
- `iris-row-filler.js`
- `preload.js`
- `portal-agent.js`
- renderer files and icons

### Test after installation

1. Open **Tax Rocket Portal Agent** from the Start Menu.
2. Start the web app with `npm run dev`.
3. In the web app, choose **Create Desktop Session → Open Desktop App**.
4. Sign in to the real FBR IRIS window locally.
5. Queue the supervised Salary test.
6. Confirm that only Salary and Salary-withholding are inspected.
7. Confirm the expected approved values appear in the FBR fields.
8. Confirm that Calculate, Save, Submit, Payment, Property, and Computations are not automatically used, and that Wealth rows were touched only if `TAXROCKET_WEALTH_AUTOFILL` was on.

The download button serves the installer from:

```text
/api/downloads/taxrocket-agent/windows
```

The installer must exist at:

```text
electron-connect/dist/TaxRocket-Portal-Agent-Setup-1.0.0.exe
```

The legacy endpoint `/api/downloads/dld-connection/windows` remains available as a compatibility alias.

### Desktop-agent troubleshooting

- **`icon.ico missing`:** check `electron-connect/assets/icon.ico`.
- **`electron-builder not found`:** run `npm install` inside `electron-connect`.
- **NSIS or 7-Zip error:** use Windows 10/11 x64 and exclude the `dist` folder from antivirus scanning if necessary.
- **Old navigation still appears:** completely close the packaged agent and all old Electron windows, then relaunch the newly built installer. A browser refresh alone does not replace the installed agent.
- **Linux/macOS build:** building a Windows `.exe` requires Wine; use a Windows machine whenever possible.

## Verification commands

Run these from the repository root after `npm install`.

### Basic checks

```bash
npm run lint
npx tsc --noEmit
npm run check:sync
```

`check:sync` verifies that the Electron main process, navigator, and row filler use the same build tag.

### Tax and application checks

```bash
npm run verify:ty2026-rates
npm run verify:ty2026-data-model
npm run verify:ty2026-filer-status
npm run verify:ty2026-subcategories
npm run verify:ty2026-tax-calculation
npm run verify:flat-income-routes
npm run verify:advance-tax
npm run verify:tax-breakdown-surfacing
npm run verify:money-precision
npm run verify:money-database
npm run verify:upload-safety
npm run verify:route-protection
npm run verify:dependency-health
npm run verify:cleanup-hygiene
npm run verify:withholding-sources
npm run verify:bank-statement-isolation
```

### Portal mapping and capture checks

```bash
npm run verify:portal-field-map
npm run verify:employment-captures
npm run verify:property-capture
npm run verify:cnic-profile-plan
npm run verify:iris-row-filler
npm run verify:iris-navigation
```

The portal suites use local fixtures and do not log into or submit to FBR.

### Browser UI checks

```bash
npx playwright install chromium
npm run verify:ui
```

To use another local web-server port:

```bash
UI_BASE_URL=http://localhost:3123 npm run verify:ui
```

### Combined verification

```bash
npm run verify:all
```

### Autofill replay and portal coverage tools

```bash
# Read-only replay against a saved job artifact
npm run replay:agent-autofill -- --job /path/to/latest-job.json

# Inspect portal coverage
npm run inventory:portal-coverage
npm run inventory:portal-evidence
```

The real portal is never used by the local fixture verification suites. Never use test fixtures as an actual return document.

## Production build and deploy

```bash
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

On a VPS, set the production `DATABASE_URL`, apply migrations, then build and start. Never run `prisma migrate reset` in production. If dependencies were installed with `npm ci --ignore-scripts`, run `npx prisma generate` before building.

## Available root scripts

```text
npm run dev
npm run build
npm run start
npm run lint
npm run verify:all
npm run verify:ui
npm run check:oauth
npm run diagnose:withholding
npm run check:sync
npm run replay:agent-autofill
npm run inventory:portal-coverage
npm run inventory:portal-evidence
```

All individual `verify:*` scripts are listed in the Verification section and are available in `package.json`.

## Tax-rule scope

- Engine: TY2026, July 2025–June 2026, Finance Act 2025.
- TY2027 is not enabled until its rules are implemented.
- Unsupported or unconfirmed tax rules refuse with `NEEDS_RULES` instead of guessing.
- Rule history and decisions are recorded in `NEEDS_RULES_IMPLEMENTATION.md`.

## Remaining production work

Before accepting real tax filings, these still need attention:

1. Persistent object storage for files and packets.
2. Broader rate-limit coverage.
3. Calculation history/audit trail and revised-return support.
4. Final FBR submission specification beyond the supervised handoff.
5. VPS hardening, HTTPS, OAuth production callbacks, and backup/restore testing.
6. Additional live-portal mapping for routes outside the current Salary and Salary-withholding test.

## Environment notes

- `NEXTAUTH_URL` must be the actual URL, not a Markdown link.
- `NEXTAUTH_SECRET` must be a strong secret outside local development.
- Google OAuth callback URLs must match the environment URL in Google Cloud.
- Without `GEMINI_API_KEY`, extraction falls back to manual entry.
- Local uploaded documents and `.env` files are excluded by `.gitignore`.

## Project structure

```text
app/                         Next.js routes and server actions
components/                  UI and filing workflow components
lib/tax/                     Tax rules, calculations, eligibility, and filing state
lib/tax/rules/ty2026/        TY2026 rate-card catalog and subcategories
prisma/schema.prisma         Database schema
prisma/migrations/           Checked-in PostgreSQL migrations
scripts/                     Verification and diagnostics
scripts/ui/                  Playwright browser suites
electron-connect/            Separate FBR Electron desktop agent
test-data/                   Clearly labelled synthetic test documents
test-fixtures/iris/          Local IRIS DOM fixtures
NEEDS_RULES_IMPLEMENTATION.md Tax-rule decision and change log
```

## Git workflow

```bash
git status --short
git add -A                         # stages edits and tracked-file deletions
git diff --cached --name-status    # review M/A/D before committing
git commit -m "Describe the change"
git pull --rebase origin main
git push origin main
```

Do not commit `.env`, credentials, real taxpayer documents, or real FBR screenshots. Do not use `git push --force` on the shared repository.
