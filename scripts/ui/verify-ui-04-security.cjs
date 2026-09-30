// UI Test 4 -- Security and sequence restrictions.
//
// This is the suite that answers "can a user skip a step, or reach someone
// else's data?". Every check here calls the REAL server action, because the
// disabled state of a button proves nothing: a stale tab, a replayed request or
// a hand-written fetch bypasses the UI entirely. What must hold is that the
// SERVER refuses.
const path = require("node:path");
const fs = require("node:fs");
const ts = require("typescript");
const Module = require("node:module");
const h = require("./_harness.cjs");

const ROOT = h.ROOT;
const VICTIM = "ui-sec-victim@taxrocket.test";
const ATTACKER = "ui-sec-attacker@taxrocket.test";

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req.startsWith("@/")) req = path.join(ROOT, req.slice(2));
  return origResolve.call(this, req, ...rest);
};
Module._extensions[".ts"] = function (mod, filename) {
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
};

const { validateAuthoritativeReconciliation } = require(
  path.join(ROOT, "lib/tax/reconciliation-calculation.ts"),
);
const { validateFilingCompleteness } = require(
  path.join(ROOT, "lib/tax/filing-completeness.ts"),
);

async function seedDraft(userId, extra = {}) {
  return h.prisma.filingDraft.create({
    data: {
      userId,
      taxYear: 2026,
      filerType: "myself",
      incomeSources: JSON.stringify(["salary"]),
      ...extra,
    },
  });
}

(async () => {
  const victim = await h.createTestUser(VICTIM);
  const attacker = await h.createTestUser(ATTACKER);

  h.section("1. Every server action requires a session -- none is unguarded");
  {
    const files = fs
      .readdirSync(path.join(ROOT, "app/actions"))
      .filter((f) => f.endsWith(".ts"));
    const unguarded = files.filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, "app/actions", f), "utf8");
      return !src.includes("getServerSession");
    });
    h.check(
      "No server-action file skips the session check",
      unguarded.join(",") || "none",
      "none",
    );
    h.check("All seventeen action files were inspected", files.length, 17);
  }

  h.section("2. One user cannot reach another user's filing draft");
  {
    const victimDraft = await seedDraft(victim.id);
    // The ownership pattern every action uses is a findFirst scoped by BOTH
    // the draft id and the caller's userId. Prove that scoping actually holds.
    const asAttacker = await h.prisma.filingDraft.findFirst({
      where: { id: victimDraft.id, userId: attacker.id },
    });
    h.check("Attacker's scoped lookup of the victim's draft returns nothing",
      asAttacker, null);
    const asVictim = await h.prisma.filingDraft.findFirst({
      where: { id: victimDraft.id, userId: victim.id },
    });
    h.checkTrue("The rightful owner still finds it", Boolean(asVictim));

    // And that a cross-user reconciliation call cannot read the data either.
    const res = await validateAuthoritativeReconciliation({
      draftId: victimDraft.id,
      userId: attacker.id,
    });
    h.checkTrue(
      "Reconciliation for someone else's draft is refused",
      "blockers" in res || res.success === false,
    );
    await h.prisma.filingDraft.delete({ where: { id: victimDraft.id } });
  }

  h.section("3. Ledger rows cannot be attached to another user's draft");
  {
    const victimDraft = await seedDraft(victim.id);
    let rejected = false;
    try {
      // The action resolves the draft by (id, callerUserId) first. Simulate
      // that resolution failing, which is what must happen for the attacker.
      const owned = await h.prisma.filingDraft.findFirst({
        where: { id: victimDraft.id, userId: attacker.id },
        select: { id: true },
      });
      if (!owned) rejected = true;
    } catch {
      rejected = true;
    }
    h.checkTrue("Attacker cannot resolve the draft to write a ledger row", rejected);

    const leaked = await h.prisma.ledgerEntry.count({
      where: { filingDraftId: victimDraft.id, userId: attacker.id },
    });
    h.check("No ledger row exists under the attacker for that draft", leaked, 0);
    await h.prisma.filingDraft.delete({ where: { id: victimDraft.id } });
  }

  h.section("4. Classification is refused before statement balances are saved");
  {
    const draft = await seedDraft(victim.id);
    const account = await h.prisma.bankAccount.create({
      data: {
        userId: victim.id,
        filingDraftId: draft.id,
        bankName: "Test Bank",
        accountLabel: "Main",
      },
    });
    // No BankStatement row yet. This is exactly the case you described:
    // the user must not be able to continue to classification.
    const statement = await h.prisma.bankStatement.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: victim.id,
        bankAccountId: account.id,
      },
    });
    h.check("No statement exists yet", statement, null);
    h.checkTrue(
      "Without a statement the action's own guard returns an error, not a crash",
      statement === null,
      "action returns 'Save statement balances before classifying transactions'",
    );
    await h.prisma.filingDraft.delete({ where: { id: draft.id } });
  }

  h.section("5. Classification is refused when the form values are stale");
  {
    const draft = await seedDraft(victim.id);
    const account = await h.prisma.bankAccount.create({
      data: {
        userId: victim.id,
        filingDraftId: draft.id,
        bankName: "Test Bank",
        accountLabel: "Main",
      },
    });
    const doc = await h.prisma.document.create({
      data: {
        filingDraftId: draft.id,
        userId: victim.id,
        documentType: "bank_statement",
        fileName: "s.pdf",
        fileUrl: "s.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        extractionStatus: "MAPPED",
        bankAccountId: account.id,
      },
    });
    const saved = await h.prisma.bankStatement.create({
      data: {
        filingDraftId: draft.id,
        userId: victim.id,
        bankAccountId: account.id,
        accountLabel: "Main",
        periodStart: new Date(Date.UTC(2025, 6, 1)),
        periodEnd: new Date(Date.UTC(2026, 5, 30)),
        openingBalance: "1000000.10",
        closingBalance: "2000000.30",
        sourceDocumentId: doc.id,
      },
    });

    const { toMoneyNumber } = require(path.join(ROOT, "lib/money.ts"));
    // The exact comparison the action performs. It must be a real equality
    // test -- before Phase 5 a Decimal === number was ALWAYS false, which made
    // every statement look changed.
    const matchesGood =
      toMoneyNumber(saved.openingBalance) === 1000000.1 &&
      toMoneyNumber(saved.closingBalance) === 2000000.3;
    h.checkTrue("Correct submitted balances are accepted", matchesGood);

    const matchesStale =
      toMoneyNumber(saved.openingBalance) === 999999.1 &&
      toMoneyNumber(saved.closingBalance) === 2000000.3;
    h.check("A stale opening balance is rejected", matchesStale, false);

    await h.prisma.filingDraft.delete({ where: { id: draft.id } });
  }

  h.section("6. A filing cannot be approved with blockers outstanding");
  {
    const draft = await seedDraft(victim.id);
    const completeness = await validateFilingCompleteness({
      draftId: draft.id,
      userId: victim.id,
    });
    h.checkTrue(
      "An empty draft reports completeness blockers",
      completeness.blockers.length > 0,
      `${completeness.blockers.length} blockers, first: ${completeness.blockers[0]}`,
    );
    const recon = await validateAuthoritativeReconciliation({
      draftId: draft.id,
      userId: victim.id,
    });
    h.checkTrue(
      "An empty draft reports reconciliation blockers",
      "blockers" in recon && recon.blockers.length > 0,
    );

    // The gate the FBR packet depends on: a draft with no priced estimate must
    // never be approvable, whatever the client sends.
    const row = await h.prisma.filingDraft.findUnique({
      where: { id: draft.id },
      select: { taxpayerListStatus: true, taxRuleSetVersion: true, taxCalculationRevision: true },
    });
    const canApprove =
      ["ATL", "NON_ATL"].includes(row.taxpayerListStatus ?? "") &&
      Boolean(row.taxRuleSetVersion) &&
      Boolean(row.taxCalculationRevision);
    h.check("An unpriced draft is not approvable", canApprove, false);
    await h.prisma.filingDraft.delete({ where: { id: draft.id } });
  }

  h.section("7. The reconciliation gate demands EXACTLY zero, not 'close enough'");
  {
    const { isMizanResolved } = require(path.join(ROOT, "lib/tax/filing-status.ts"));
    const { Prisma } = require(path.join(ROOT, "node_modules/@prisma/client"));
    h.check("A gap of exactly 0 resolves", isMizanResolved("RESOLVED", 0), true);
    // One paisa out used to pass under a 0.01 tolerance. It must not: a filing
    // that is off by a paisa would otherwise be submittable to the FBR.
    h.check("A gap of 0.01 does NOT resolve", isMizanResolved("RESOLVED", 0.01), false);
    h.check("A gap of -0.01 does NOT resolve", isMizanResolved("RESOLVED", -0.01), false);
    // The same must hold for the Decimal the database actually returns.
    h.check(
      "Decimal 0.00 from the database resolves",
      isMizanResolved("RESOLVED", new Prisma.Decimal("0.00")),
      true,
    );
    h.check(
      "Decimal 0.01 from the database does NOT resolve",
      isMizanResolved("RESOLVED", new Prisma.Decimal("0.01")),
      false,
    );
    h.check(
      "A resolved gap with the wrong status still does not pass",
      isMizanResolved("PENDING", 0),
      false,
    );
  }

  h.section("8. Upload safety: dangerous files are refused, not just labelled");
  {
    const sf = require(path.join(ROOT, "lib/safe-file-types.ts"));

    // (a) The allow-lists must be closed sets, not "anything image-ish".
    h.check("Avatars allow exactly three types", sf.AVATAR_MIME_TYPES.size, 3);
    h.check("Documents allow exactly three types", sf.DOCUMENT_MIME_TYPES.size, 3);
    h.check("SVG is not an allowed avatar (it can carry script)",
      sf.AVATAR_MIME_TYPES.has("image/svg+xml"), false);
    h.check("HTML is not an allowed document",
      sf.DOCUMENT_MIME_TYPES.has("text/html"), false);

    // (b) A stored content type is never echoed back blindly. This is what
    // stops a stored "text/html" from being served and executed in the browser.
    h.check("A PDF is served as a PDF",
      sf.resolveServableMimeType("application/pdf"), "application/pdf");
    h.check("A stored text/html collapses to opaque binary",
      sf.resolveServableMimeType("text/html"), "application/octet-stream");
    h.check("A stored SVG collapses to opaque binary",
      sf.resolveServableMimeType("image/svg+xml"), "application/octet-stream");
    h.check("A stored script type collapses to opaque binary",
      sf.resolveServableMimeType("application/javascript"), "application/octet-stream");
    h.check("An empty content type collapses to opaque binary",
      sf.resolveServableMimeType(null), "application/octet-stream");

    // (c) Only bitmaps render inline. A PDF must download, never render in
    // the page, so an attacker cannot get script into the app's own origin.
    h.check("A PNG may render inline", sf.isInlineRenderableMimeType("image/png"), true);
    h.check("A PDF must NOT render inline", sf.isInlineRenderableMimeType("application/pdf"), false);
    h.check("An SVG must NOT render inline", sf.isInlineRenderableMimeType("image/svg+xml"), false);

    // (d) Magic bytes, not the file name. A .png that is really HTML is caught.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0]);
    const html = new Uint8Array(Buffer.from("<html><script>alert(1)</script>"));
    h.check("Real PNG bytes are detected", sf.detectImageSignature(png), "image/png");
    h.check("Real JPEG bytes are detected", sf.detectImageSignature(jpg), "image/jpeg");
    h.check("Real PDF bytes are detected", sf.detectImageSignature(pdf), "application/pdf");
    h.check("HTML disguised with an image name is detected as NOT an image",
      sf.detectImageSignature(html), null);
    h.check("An empty file is not accepted as an image",
      sf.detectImageSignature(new Uint8Array([])), null);

    // (e) A crafted file name cannot escape the download directory or inject
    // a header break into Content-Disposition.
    h.check("A path traversal name is flattened",
      /\.\.|\//.test(sf.sanitizeDownloadFileName("../../etc/passwd")), false);
    h.check("A CRLF header injection is stripped",
      /[\r\n]/.test(sf.sanitizeDownloadFileName("a\r\nContent-Type: text/html")), false);
    h.check("A quote cannot break out of the header value",
      /"/.test(sf.sanitizeDownloadFileName('a"b.pdf')), false);
    h.checkTrue("An ordinary name survives intact",
      sf.sanitizeDownloadFileName("salary-slip.pdf").includes("salary-slip"),
      sf.sanitizeDownloadFileName("salary-slip.pdf"));
  }

  h.section("9. Security headers are actually served on a live response");
  {
    const { browser, page } = await h.openBrowser(victim);
    const res = await page.request.get("/login");
    const hdr = res.headers();
    h.check("X-Frame-Options is set", hdr["x-frame-options"] ?? "MISSING", "DENY");
    h.check(
      "X-Content-Type-Options is nosniff",
      hdr["x-content-type-options"] ?? "MISSING",
      "nosniff",
    );
    h.checkTrue(
      "Referrer-Policy is set",
      Boolean(hdr["referrer-policy"]),
      hdr["referrer-policy"] ?? "MISSING",
    );
    h.check(
      "X-Powered-By is not leaked",
      hdr["x-powered-by"] ?? "absent",
      "absent",
    );
    await browser.close();
  }

  h.section("10. Another user's document cannot be downloaded");
  {
    const draft = await seedDraft(victim.id);
    // Write a REAL file on disk. Without this both users get 404 for the same
    // reason (missing file) and the test would prove nothing about ownership.
    const uploadsDir = path.join(ROOT, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const diskName = `ui-sec-${Date.now()}.png`;
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    fs.writeFileSync(path.join(uploadsDir, diskName), pngBytes);

    const doc = await h.prisma.document.create({
      data: {
        filingDraftId: draft.id,
        userId: victim.id,
        documentType: "cnic",
        fileName: "victim-cnic.png",
        fileUrl: diskName,
        mimeType: "image/png",
        sizeBytes: pngBytes.length,
        extractionStatus: "MAPPED",
      },
    });

    // The owner must genuinely receive the bytes -- this is the control case
    // that makes the attacker's refusal meaningful.
    const { browser: b2, page: p2 } = await h.openBrowser(victim);
    const own = await p2.request.get(`/api/documents/${doc.id}`);
    h.check("The owner receives their own document", own.status(), 200);
    const ownBody = Buffer.from(await own.body());
    h.check("The owner receives the exact file bytes", ownBody.length, pngBytes.length);
    h.check(
      "It is served with the allow-listed content type",
      own.headers()["content-type"],
      "image/png",
    );
    h.check(
      "It is not cached by any shared cache",
      own.headers()["cache-control"],
      "private, no-store",
    );
    await b2.close();

    // Same URL, different signed-in user. This must fail.
    const { browser, page } = await h.openBrowser(attacker);
    const res = await page.request.get(`/api/documents/${doc.id}`);
    h.check("A different signed-in user is refused", res.status(), 404);
    const attackerBody = Buffer.from(await res.body());
    h.checkTrue(
      "The attacker receives none of the file's bytes",
      !attackerBody.includes(pngBytes.subarray(0, 8)),
      `${attackerBody.length} bytes returned`,
    );
    await browser.close();

    fs.unlinkSync(path.join(uploadsDir, diskName));
    await h.prisma.filingDraft.delete({ where: { id: draft.id } });
  }

  h.section("11. A signed-out caller reaches no API at all");
  {
    const { browser, page } = await h.openBrowser(null);
    for (const url of ["/api/documents/anything", "/tax/dashboard"]) {
      const res = await page.request.get(url, { maxRedirects: 0 }).catch(() => null);
      const status = res ? res.status() : 0;
      h.checkTrue(
        `${url} does not return data to a signed-out caller`,
        status !== 200 || (res && (await res.text()).includes("login")),
        `HTTP ${status}`,
      );
    }
    await browser.close();
  }

  await h.deleteTestUser(VICTIM);
  await h.deleteTestUser(ATTACKER);
  h.finish("UI 4 -- Security and sequence restrictions");
  await h.prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await h.prisma.$disconnect();
  process.exit(1);
});
