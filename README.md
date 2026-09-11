# TaxRocket

TaxRocket is a guided Pakistan tax-filing workspace built with Next.js. It helps a taxpayer move through profile setup, document review, bank-statement reconciliation, ledger preparation, tax estimation, filing-packet approval, and the FBR connection handoff.

> **Status:** Pilot. The tax engine implements **Tax Year 2026 only** (Finance Act 2025). TY2027 is hidden from the UI until its rules are implemented. The FBR step prepares and gates the handoff to a local trusted desktop agent; it is not a complete FBR API submission.

## Technology

- Next.js 14.2.x, React 18, TypeScript, Tailwind CSS
- Prisma 5 with PostgreSQL (Docker locally; PostgreSQL on the production VPS)
- NextAuth with Google OAuth (Google login only)
- Gemini AI for document/bank-data extraction and classification (manual entry fallback exists)
- PDFKit for filing packet PDFs
- XLSX support for structured bank statements
- Playwright for browser (UI) test suites

## Main filing flow

1. Sign in with Google
2. Complete taxpayer profile and filing setup (Tax Year 2026)
3. Upload and review required tax documents
4. Extract and map document data
5. Import or enter bank statements and transactions
6. Maintain income, expense, asset, and liability ledger entries
7. Resolve wealth reconciliation
8. Calculate a route-specific TY2026 estimate (salary, pension, rent, bank profit, dividend, services, business, capital gains, non-resident, other income, imports, advance tax)
9. Confirm the withholding-duplicate check if raised, then approve a versioned filing packet
10. Final submit gate (Submit / Not now), then the FBR trusted-agent handoff

## Requirements

- **Node.js 20.x LTS** (Next 14 needs 18.18+; use 20 to match CI)
- npm (ships with Node)
- **PostgreSQL 16** running locally (recommended: `postgres:16` Docker container) + an empty `taxrocket` database
- A **Google OAuth application** for login (web client; authorized redirect `http://localhost:3000/api/auth/callback/google` for local dev)
- A **Gemini API key** (recommended; without it AI extraction is skipped and manual entry is used)

## Local setup

```bash
# 0. Get the code (clone, or download/extract the workspace with its .git folder)
cd tax-rocket

# 1. Check Node
node --version        # want v20.x

# 2. Install dependencies
npm install

# 3. Create .env in the project root (template below; never commit it)

# 4. Create the database (once), with Postgres running:
#    CREATE DATABASE taxrocket;

# 5. Generate the client and apply the checked-in migrations
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status     # should report "up to date"

# 6. Start the dev server
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

Use `migrate deploy`, not `migrate dev`. The migration history is already written and committed; `migrate dev` tries to author a new migration, needs a shadow database, and fails on a non-interactive shell. `deploy` applies exactly the committed migrations and nothing else.

### `.env` template

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/taxrocket"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-output-of-openssl-rand-base64-32"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-3.5-flash"

# Live entry — writing the approved packet's amounts into IRIS cells.
# Off unless this says so; it is the deployment's half of a two-key switch.
# TAXROCKET_ALLOW_LIVE_FILING="true"
```

### Two keys are needed before anything is typed into IRIS

Writing into a government return is deliberately gated twice, and both halves must be on:

1. **The operator's key** — in the desktop agent's own shell (not this file; `electron-connect`
   reads no `.env`): `TAXROCKET_REAL_AUTOFILL=dry|live`.
2. **The deployment's key** — `TAXROCKET_ALLOW_LIVE_FILING=true` in the **server** environment.
   Accepted spellings are the agent's own (`true`, `1`, `on`, `yes`); anything else, including an
   empty or misspelled value, means off. There is no DB row for it on purpose.

With only (1) set, the agent logs that writes are blocked by the deployment and runs as a dry
run. With both, `mode` becomes `supervised_live_filing`, and the FBR panel clearly tells the user
that supervised entry is enabled. Even then the agent writes only into a section whose
header/row binding it verified on screen — today that is **Salary**, and nothing else — and it
never uploads, pays, saves or submits. `verify:fbr-contracts` locks all of this.

To turn it back off: unset the variable and restart the web app. Nothing else has to change.

- `NEXTAUTH_SECRET`: generate with `openssl rand -base64 32` (Git Bash ships openssl on Windows).
- Google callback URL in Google Cloud Console must be `http://localhost:3000/api/auth/callback/google`.

## Verification suites

Offline suites (no database needed):

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
npm run verify:upload-safety
npm run verify:route-protection
npm run verify:dependency-health
npm run verify:cleanup-hygiene
npm run verify:portal-field-map     # IRIS code mapping + the capture-evidence gate
npm run verify:cnic-profile-plan    # CNIC -> profile, card expiry, cross-year reuse
```

Database-backed suites (need `DATABASE_URL` + migrated DB):

```bash
npm run verify:withholding-sources
npm run verify:money-database
npm run verify:bank-statement-isolation
```

`npm run verify:all` runs the offline + database suites in one go.

Browser suites (need the dev server running, a migrated DB, and Playwright browsers):

```bash
npx playwright install chromium   # once per machine
npm run verify:ui                 # auth + wizard + calculation + security
npm run verify:iris-navigation    # 100 checks against a real Chromium, no portal access
npm run verify:iris-row-filler    # 27 checks, same browser fixture
```

`verify:ui` expects the dev server on `http://localhost:3000`; point it elsewhere with
`UI_BASE_URL=http://localhost:3123 npm run verify:ui`. These suites never touch the real IRIS
portal — no login, no writes.

Type check:

```bash
npx tsc --noEmit
```

## Production build & deploy (VPS)

```bash
npx prisma generate
npm run build
npm start
```

On the VPS: set `DATABASE_URL` to the production PostgreSQL URL, run `npx prisma migrate deploy`, then build and start. Never run `prisma migrate reset` in production. If dependencies were installed with `npm ci --ignore-scripts`, run `npx prisma generate` before building.

## Available scripts

```bash
npm run dev       # Start the development server
npm run build     # Create an optimized production build
npm run start     # Start the production server
npm run lint      # Run the configured lint command
npm run verify:all  # All offline + database suites
npm run verify:ui   # All four Playwright browser suites
npm run check:oauth         # Diagnose Google OAuth callback config
npm run diagnose:withholding  # Inspect withholding-source resolution
```

Individual `verify:*` suites are listed in the Verification section above; every suite also exists as its own `verify:<name>` script in `package.json`.

## Desktop agent (separate app)

The FBR filing agent is an Electron desktop app living in `electron-connect/` with its own `package.json`. It is built and installed independently:

- Build instructions: `INSTALLER_BUILD.md`
- Agent docs: `electron-connect/README.md`
- Running, updating, or reinstalling the **web app never touches an already-installed agent** — they are separate processes; the agent only talks to the web app over localhost during a filing session.

## Tax-rule scope

- Engine: TY2026 (July 2025 – June 2026, Finance Act 2025) only. TY2027 is removed from `SUPPORTED_TAX_YEARS` until its rules are implemented.
- 152 rate-card rules catalogued; advance tax 27/27 priced; imports, mobile bands, late filer, pension 70+, and aggregation (75% salary test) implemented and pinned by suites.
- Anything without a confirmed rule refuses with `NEEDS_RULES` instead of guessing. Rule history and decisions: `NEEDS_RULES_IMPLEMENTATION.md`.

## Remaining production work

Before accepting real tax filings, these still need attention:

1. Persistent object storage (files/packets are on local disk — fine for one VPS, not for serverless/multi-instance).
2. Rate-limit coverage (currently 3/18 server actions).
3. Calculation history/audit trail (recalculation replaces lines) and revised-return support (one draft per user per year).
4. Final FBR submission spec beyond the supervised agent handoff.
5. Client confirmation of the two Sukuk boundary notes and the adjustable/final defaults (safe defaults are live).
6. VPS hardening, HTTPS, OAuth production callback, backup/restore testing.

## Environment notes

- `NEXTAUTH_URL` must be the actual URL, not a Markdown link.
- `NEXTAUTH_SECRET` should be a strong secret in every non-local environment.
- Google OAuth callback URLs must match the environment URL configured in Google Cloud.
- Without `GEMINI_API_KEY`, extraction falls back to manual entry (UX still works).

## Project structure

```text
app/                         Next.js routes and server actions
components/                  UI and filing workflow components
lib/tax/                     Tax rules, calculations, eligibility, and filing state
lib/tax/rules/ty2026/        TY2026 rate-card catalog + subcategories
prisma/schema.prisma         Database schema
prisma/migrations/           Checked-in PostgreSQL migrations
scripts/                     verify:* suites (offline + DB) and diagnostics
scripts/ui/                  Playwright browser suites
electron-connect/            FBR desktop agent (separate Electron app)
test-documents/              Sample fixtures for manual upload testing
NEEDS_RULES_IMPLEMENTATION.md  Tax-rule decision + change log (§1–§17)
```

## Git workflow

```bash
git status
git add -A            # .gitignore already excludes node_modules/.env/.next
git commit -m "..."
git pull --rebase origin main
git push origin main  # plain push only appends history; never --force
```
