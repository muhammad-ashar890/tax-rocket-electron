# Local sync checklist — replace these on your machine

Har baar jo files main workspace mein edit karta hoon, un naam meri reply mein aur neeche is list mein milenge.
Download mein yeh nahi hain (gitignored): `node_modules/`, `.env`, `uploads/`, `.next/`.

## Is round (2026-09-10 — packet coverage gate override) ki files

- **NEW/CHANGED** `lib/tax/portal-field-map.ts`
- **NEW/CHANGED** `app/actions/packet.ts`
- **NEW/CHANGED** `components/tax/filing/hooks/use-filing-finalization.ts`
- **NEW/CHANGED** `components/tax/filing/wizard-packet-step.tsx`
- **NEW/CHANGED** `components/tax/filing/filing-wizard.tsx`
- **NEW/CHANGED** `scripts/verify-portal-field-map.cjs`
- **NEW/CHANGED** `scripts/verify-iris-navigation.cjs`
- **NEW/CHANGED** `FBR_FILL_PHASES_2026-09-09.md`
- **NEW/CHANGED** `HANDOFF_FILL_FIXES_2026-09-09.md`
- **NEW** `scripts/check-workspace-sync.cjs` + `package.json` (naya `npm run check:sync`)

**Agar verify script kahe** `the action must read the gaps through the shared helper` — yeh test ka
bug nahi, aapke tree mein `app/actions/packet.ts` pichhli copy hai (naya signature mojood hai, lekin
shared helper ka call + import nahi). `npm run check:sync` har file par OK/STALE naam se batata hai,
is liye copy-order ka faisla wahi se karo. Jaldi check karna ho to:

```powershell
Select-String -Path app\actions\packet.ts -Pattern "coverageGate.coverage" -Quiet   # False = purani copy
```

## Poora pending set (ab tak ki saari changes)

### Web / server code — copy these, then restart `npm run dev`
- [ ] `app/actions/extraction.ts`
- [ ] `app/actions/packet.ts`
- [ ] `app/tax/fbr-connect/page.tsx`
- [ ] `components/tax/fbr-connect-client.tsx`
- [ ] `components/tax/filing/config/filing-wizard-config.ts`
- [ ] `components/tax/filing/filing-wizard.tsx`
- [ ] `components/tax/filing/hooks/use-filing-documents.ts`
- [ ] `components/tax/filing/hooks/use-filing-finalization.ts`
- [ ] `components/tax/filing/wizard-documents-step.tsx`
- [ ] `components/tax/filing/wizard-packet-step.tsx`
- [ ] `lib/tax/cnic-profile.ts`
- [ ] `lib/tax/fbr-agent-config.ts`
- [ ] `lib/tax/filing-status.ts`
- [ ] `lib/tax/iris-field-codes.ts`
- [ ] `lib/tax/portal-field-map.ts`
- [ ] `lib/tax/portal-row-evidence.ts`

### Desktop agent — COPY ALL FOUR TOGETHER (stamp guard refuses a mixed set)
- [ ] `electron-connect/README.md`
- [ ] `electron-connect/iris-navigation.js`
- [ ] `electron-connect/iris-row-filler.js`
- [ ] `electron-connect/main.js`

### Test suites — copy too, warna verify checks laal aayenge
- [ ] `scripts/portal-coverage-inventory.cjs`
- [ ] `scripts/replay-agent-autofill.cjs`
- [ ] `scripts/verify-cnic-profile-plan.cjs`
- [ ] `scripts/verify-fbr-contracts.cjs`
- [ ] `scripts/verify-iris-navigation.cjs`
- [ ] `scripts/verify-iris-row-filler.cjs`
- [ ] `scripts/verify-portal-field-map.cjs`
- [ ] `scripts/verify-ty2026-filer-status.cjs`

### Docs (reference only, copy jab free ho)
- [ ] `ELECTRON_FILL_ANALYSIS_2026-09-09.md`
- [ ] `FBR_FILL_PHASES_2026-09-09.md`
- [ ] `HANDOFF_FILL_FIXES_2026-09-09.md`
- [ ] `LOCAL_SYNC_CHECKLIST.md`
- [ ] `README.md`

### Lockfile / manifest
- [ ] `package-lock.json`
- [ ] `package.json`

## Copy karne ke baad

```bash
npm ci                      # lockfile ke saath clean install (preferred)
npx prisma generate
npm run check:sync           # pehle yeh: saari STALE files naam se batata hai
node scripts/verify-portal-field-map.cjs      # 15 pass
node scripts/verify-fbr-contracts.cjs         # 22 pass
node scripts/verify-cnic-profile-plan.cjs     # 22 pass
npm run build                    # 'Compiled successfully'

# live portal writes ke liye (optional, do NOT commit):
# root .env  ->  TAXROCKET_ALLOW_LIVE_FILING="true"

# agent shell (PowerShell):
$env:TAXROCKET_REAL_AUTOFILL = "live"
npm run dev
```

_Updated 2026-09-10 — 35 paths._
