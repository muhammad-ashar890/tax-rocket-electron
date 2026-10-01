"use server";

import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import { createNotification } from "@/app/actions/notifications";
import { serializePacketMoney } from "@/lib/money";
import { toMoneyAmount, toMoneyNumber, type MoneyInput } from "@/lib/money";
import {
  buildPacketRouteMetadata,
  buildPortalFieldMap,
  describeUnmappedPortalSources,
} from "@/lib/tax/portal-field-map";
import {
  extractMappedSalaryGross,
  extractMappedSalaryWithholding,
} from "@/lib/tax/withholding-sources";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) throw new Error("User profile not found");

  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: { id: true, userId: true },
  });

  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

function buildPacketPdf(snapshotJson: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ margin: 48 });
    const chunks: Buffer[] = [];

    document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    const snapshot = JSON.parse(snapshotJson) as {
      filing: {
        taxYear: number;
        filerType: string | null;
        businessStructure: string | null;
        residencyStatus?: string | null;
        taxpayerListStatus?: string | null;
        taxpayerListStatusSource?: string | null;
        taxRuleSetVersion?: string | null;
        taxCalculationRevision?: string | null;
        taxableIncome?: MoneyInput;
        taxPayable?: MoneyInput;
        refundDue?: MoneyInput;
        taxCalculationStatus?: string;
        reconciliationGap?: MoneyInput;
      };
      documents: { documentType: string; fileName: string }[];
      ledgerEntries: {
        entryType: string;
        category: string | null;
        description: string;
        amount: number;
      }[];
    };

    document.fontSize(20).text("TaxRocket Filing Packet", { underline: true });
    document.moveDown();
    document.fontSize(11).text(`Tax Year: ${snapshot.filing.taxYear}`);
    document.text(`Filer: ${snapshot.filing.filerType ?? "Not specified"}`);
    document.text(
      `Business structure: ${snapshot.filing.businessStructure ?? "Not specified"}`,
    );
    document.text(
      `Residency: ${snapshot.filing.residencyStatus === "non_resident" ? "Non-Resident" : snapshot.filing.residencyStatus === "resident" ? "Resident" : "Not selected"}`,
    );
    document.text(
      `Taxpayer-list status: ${snapshot.filing.taxpayerListStatus ?? "Not selected"}`,
    );
    document.text(
      `Status source: ${snapshot.filing.taxpayerListStatusSource ?? "Not selected"}`,
    );
    document.text(
      `Tax rule set: ${snapshot.filing.taxRuleSetVersion ?? "Not selected"}`,
    );

    document.moveDown();
    document.fontSize(14).text("Tax Summary");
    const taxCalculationReady =
      snapshot.filing.taxCalculationStatus === "ESTIMATE";
    // Converted before formatting. These come straight off the draft, where
    // they are Decimal columns, and `Decimal.toLocaleString()` does not group
    // thousands: the final packet would print "PKR 3685290" instead of
    // "PKR 3,685,290" on the document that goes to the FBR.
    const taxValue = (value?: MoneyInput) =>
      taxCalculationReady && value !== null && value !== undefined
        ? `PKR ${toMoneyNumber(value).toLocaleString()}`
        : "Pending — route-specific tax rules required";
    document
      .fontSize(11)
      .text(`Taxable income: ${taxValue(snapshot.filing.taxableIncome)}`);
    document.text(`Tax payable: ${taxValue(snapshot.filing.taxPayable)}`);
    document.text(`Refund due: ${taxValue(snapshot.filing.refundDue)}`);
    document.text(
      `Reconciliation gap: PKR ${Math.abs(
        toMoneyAmount(snapshot.filing.reconciliationGap),
      ).toLocaleString()}`,
    );

    document.moveDown();
    document.fontSize(14).text("Ledger Entries");
    document.fontSize(10);
    if (snapshot.ledgerEntries.length === 0) {
      document.text("No ledger entries recorded.");
    } else {
      for (const entry of snapshot.ledgerEntries) {
        document.text(
          `${entry.entryType} | ${entry.category ?? "—"} | ${entry.description} | PKR ${toMoneyNumber(
            entry.amount,
          ).toLocaleString()}`,
        );
      }
    }

    document.moveDown();
    document.fontSize(14).text("Attached Documents");
    document.fontSize(10);
    if (snapshot.documents.length === 0) {
      document.text("No documents attached.");
    } else {
      for (const file of snapshot.documents) {
        document.text(`${file.documentType}: ${file.fileName}`);
      }
    }

    document.moveDown();
    document
      .fontSize(9)
      .fillColor("#666666")
      .text(
        "Generated by TaxRocket. This packet is a snapshot for user review.",
      );
    document.end();
  });
}

export async function getLatestFilingPacketAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const packet = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
      },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        packetHash: true,
        status: true,
        approvalStatus: true,
        taxPayable: true,
        refundDue: true,
        fileUrl: true,
        createdAt: true,
        snapshotJson: true,
      },
    });

    // The mapping gaps live INSIDE the snapshot; re-reading them on fetch means the
    // practitioner sees the same "manual entry required" list on the packet step
    // whether the packet was just generated or was loaded from a previous session.
    let mappingGaps: unknown = null;
    if (packet) {
      try {
        const snapshot = JSON.parse(packet.snapshotJson) as {
          portalFieldMap?: { mappingGaps?: unknown };
        };
        mappingGaps = snapshot.portalFieldMap?.mappingGaps ?? null;
      } catch {
        mappingGaps = null;
      }
    }

    return {
      success: true,
      // Money leaves the database layer as a plain number: Decimal is not
      // JSON-serialisable to the client and misbehaves with `+` and `if`.
      packet: packet
        ? {
            ...serializePacketMoney(packet),
            pdfUrl: packet.fileUrl ? `/api/packets/${packet.id}` : null,
            mappingGaps,
          }
        : null,
    };
  } catch (error) {
    console.error("Error fetching filing packet:", error);
    return { success: false, error: "Failed to fetch filing packet" };
  }
}

/**
 * `acceptUnmappedPortalSources` is the practitioner's explicit override of the
 * coverage gate: the packet is generated, the amounts that IRIS will not be filled
 * for stay listed in the snapshot, and the wizard says so. Without it the gate
 * refuses, because a packet that quietly omits priced income is worse than no
 * packet.
 */
export async function generateFilingPacketAction(
  draftId: string,
  options?: { acceptUnmappedPortalSources?: boolean },
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const [
      draftData,
      documents,
      ledgerEntries,
      latestPacket,
      taxCredits,
      salaryCertificate,
    ] =
      await Promise.all([
        prisma.filingDraft.findUnique({
          where: { id: draft.id },
          select: {
            taxYear: true,
            status: true,
            filerType: true,
            businessStructure: true,
            residencyStatus: true,
            incomeSources: true,
            readinessChecks: true,
            openingWealth: true,
            closingWealth: true,
            reconciliationGap: true,
            reconciliationStatus: true,
            reconciliationMethod: true,
            reconciliationNote: true,
            taxableIncome: true,
            taxWithheld: true,
            taxPayable: true,
            refundDue: true,
            taxCalculationStatus: true,
            taxpayerListStatus: true,
            taxpayerListStatusSource: true,
            taxpayerListStatusCheckedAt: true,
            taxRuleSetVersion: true,
            taxCalculationRevision: true,
            packetApprovalConfirmed: true,
          },
        }),
        prisma.document.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
          },
          select: {
            documentType: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            extractionStatus: true,
          },
        }),
        prisma.ledgerEntry.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
          },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            entryDate: true,
            entryType: true,
            category: true,
            description: true,
            amount: true,
            source: true,
          },
        }),
        prisma.filingPacket.findFirst({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
          },
          orderBy: { version: "desc" },
          select: { id: true, version: true, approvalStatus: true },
        }),
        prisma.filingTaxCredit.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
          },
          select: {
            id: true,
            section: true,
            subcategory: true,
            amount: true,
            source: true,
          },
        }),
        prisma.document.findFirst({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            documentType: "salary_certificate",
            extractionStatus: "MAPPED",
          },
          select: { extractedData: true },
        }),
      ]);

    if (!draftData) {
      return { success: false, error: "Filing draft not found" };
    }

    if (
      draftData.residencyStatus !== "resident" &&
      draftData.residencyStatus !== "non_resident"
    ) {
      return {
        success: false,
        error:
          "Missing filing context: select Resident or Non-Resident before generating the packet",
      };
    }

    if (
      draftData.taxCalculationStatus !== "ESTIMATE" ||
      !["ATL", "NON_ATL", "LATE_FILER"].includes(
        draftData.taxpayerListStatus ?? "",
      ) ||
      !draftData.taxRuleSetVersion ||
      !draftData.taxCalculationRevision
    ) {
      return {
        success: false,
        error:
          "Calculate a current ATL, Late Filer or Non-ATL tax estimate first",
      };
    }

    // Re-read authoritative document/account/statement/transaction state at
    // packet-generation time. A stale approval checkbox must never be enough
    // to create a packet after account data becomes incomplete.
    const [completeness, reconciliation] = await Promise.all([
      validateFilingCompleteness({
        draftId: draft.id,
        userId: draft.userId,
      }),
      validateAuthoritativeReconciliation({
        draftId: draft.id,
        userId: draft.userId,
      }),
    ]);
    const integrityBlockers = Array.from(
      new Set([
        ...completeness.blockers,
        ...("blockers" in reconciliation ? reconciliation.blockers : []),
      ]),
    );
    if (integrityBlockers.length > 0) {
      return { success: false, error: integrityBlockers.join(" · ") };
    }

    if (!draftData.packetApprovalConfirmed) {
      return {
        success: false,
        error: "Approve the filing data before generating the final packet",
      };
    }

    const parsedIncomeSources = JSON.parse(draftData.incomeSources) as string[];
    const parsedReadinessChecks = JSON.parse(
      draftData.readinessChecks,
    ) as string[];
    const salaryCertificateTaxWithheld = extractMappedSalaryWithholding(
      salaryCertificate?.extractedData ?? null,
    );
    const salaryCertificateGrossSalary = extractMappedSalaryGross(
      salaryCertificate?.extractedData ?? null,
    );

    const bankAccountsForPacket = await prisma.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      select: { id: true, iban: true },
    });

    // Build portalFieldMap using IRIS codes for Electron agent
    const portalFieldMap = buildPortalFieldMap({
      taxYear: draftData.taxYear,
      filerType: draftData.filerType,
      taxpayerListStatus: draftData.taxpayerListStatus,
      ledgerEntries: ledgerEntries.map((e) => ({
        id: e.id,
        entryType: e.entryType,
        category: e.category,
        description: e.description,
        amount: e.amount as any,
      })),
      taxCredits: taxCredits.map((c) => ({
        id: c.id,
        section: c.section,
        subcategory: c.subcategory,
        amount: c.amount as any,
        source: c.source,
      })),
      taxableIncome: draftData.taxableIncome
        ? Number(draftData.taxableIncome)
        : 0,
      taxWithheld: draftData.taxWithheld ? Number(draftData.taxWithheld) : 0,
      salaryCertificateTaxWithheld,
      salaryCertificateGrossSalary,
      // Wealth Statement bank rows (7030): IBAN + closing balance per account.
      bankAccounts:
        "preview" in reconciliation && reconciliation.preview
          ? reconciliation.preview.accountBalances.flatMap((balance) => {
              const account = bankAccountsForPacket.find(
                (candidate) => candidate.id === balance.bankAccountId,
              );
              return account?.iban
                ? [
                    {
                      iban: account.iban,
                      bankName: balance.bankName,
                      accountLabel: balance.accountLabel,
                      closingBalance: balance.closingBalance,
                    },
                  ]
                : [];
            })
          : [],
    });
    const routeMetadata = buildPacketRouteMetadata({
      taxYear: draftData.taxYear,
      filerType: draftData.filerType,
      businessStructure: draftData.businessStructure,
      incomeSources: parsedIncomeSources,
    });

    // A packet whose income the portal cannot carry must not be filed as if it
    // were complete. `unmappedCategories` means the ENGINE priced that income (so
    // taxCalculationStatus is ESTIMATE and every money gate above passes) while
    // the PORTAL map has no verified IRIS line for it — a business/services/
    // capital-gains taxpayer would otherwise generate a salary-only packet, have
    // the agent fill it cleanly, and file a return that quietly omits income.
    const coverageGate = describeUnmappedPortalSources(portalFieldMap.mappingGaps);
    if (coverageGate.blocked.length > 0 && !options?.acceptUnmappedPortalSources) {
      return {
        success: false,
        error: coverageGate.refusal,
        // The UI offers the override from these same numbers, never from its own
        // copy of them.
        unmappedPortalSources: coverageGate.blocked,
      };
    }
    const coverage = coverageGate.coverage;

    const snapshot = {
      generatedAt: new Date().toISOString(),
      filing: {
        ...draftData,
        status:
          latestPacket?.approvalStatus === "APPROVED"
            ? "IN_PROGRESS"
            : draftData.status,
        incomeSources: parsedIncomeSources,
        readinessChecks: parsedReadinessChecks,
      },
      documents,
      ledgerEntries,
      taxCredits,
      routeMetadata,
      portalFieldMap,
      coverage,
    };

    const snapshotJson = JSON.stringify(snapshot);
    const packetHash = createHash("sha256").update(snapshotJson).digest("hex");
    const version = (latestPacket?.version ?? 0) + 1;

    const packet = await prisma.$transaction(async (tx) => {
      if (latestPacket?.approvalStatus === "APPROVED") {
        await tx.filingPacket.update({
          where: { id: latestPacket.id },
          data: {
            approvalStatus: "SUPERSEDED",
            status: "SUPERSEDED",
          },
        });

        await tx.filingDraft.update({
          where: { id: draft.id },
          data: { status: "IN_PROGRESS" },
        });
      }

      return tx.filingPacket.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          version,
          packetHash,
          snapshotJson,
          status: "GENERATED",
          approvalStatus: "APPROVED",
          approvedAt: new Date(),
          approvedByUserId: draft.userId,
          taxPayable: draftData.taxPayable ?? 0,
          refundDue: draftData.refundDue ?? 0,
        },
        select: {
          id: true,
          version: true,
          packetHash: true,
          status: true,
          approvalStatus: true,
          taxPayable: true,
          refundDue: true,
          createdAt: true,
        },
      });
    });

    await prisma.filingDraft.update({
      where: { id: draft.id },
      data: { status: "APPROVED_FOR_FILING" },
    });

    await createNotification({
      userId: draft.userId,
      type: "FILING_STATUS",
      title: `Filing packet v${version} generated`,
      message: `Tax year ${draftData.taxYear} packet is ready for your review.`,
      link: `/tax/new?draftId=${draft.id}`,
    });

    // Same boundary as the fetch action: the client receives numbers.
    // The mapping gaps ride along so the practitioner sees, BEFORE approving,
    // which income the portal will not be filled for — the alternative is finding
    // out from an empty IRIS grid during a filing window.
    const mappingGaps =
      (snapshot.portalFieldMap && snapshot.portalFieldMap.mappingGaps) || null;
    return {
      success: true,
      packet: { ...serializePacketMoney(packet), mappingGaps, coverage },
    };
  } catch (error) {
    console.error("Error generating filing packet:", error);
    return { success: false, error: "Failed to generate filing packet" };
  }
}

export async function generateFilingPacketPdfAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const [packet, completeness, reconciliation] = await Promise.all([
      prisma.filingPacket.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          status: { not: "SUPERSEDED" },
        },
        orderBy: { version: "desc" },
      }),
      validateFilingCompleteness({
        draftId: draft.id,
        userId: draft.userId,
      }),
      validateAuthoritativeReconciliation({
        draftId: draft.id,
        userId: draft.userId,
      }),
    ]);

    const integrityBlockers = Array.from(
      new Set([
        ...completeness.blockers,
        ...("blockers" in reconciliation ? reconciliation.blockers : []),
      ]),
    );
    if (integrityBlockers.length > 0) {
      return { success: false, error: integrityBlockers.join(" · ") };
    }

    if (!packet) {
      return {
        success: false,
        error: "Generate a current packet snapshot first",
      };
    }

    const pdfBuffer = await buildPacketPdf(packet.snapshotJson);
    const packetDirectory = path.join(process.cwd(), "uploads", "packets");
    await mkdir(packetDirectory, { recursive: true });

    const storedFileName = `${packet.id}.pdf`;
    await writeFile(path.join(packetDirectory, storedFileName), pdfBuffer);

    const fileUrl = `packets/${storedFileName}`;
    await prisma.filingPacket.update({
      where: { id: packet.id },
      data: { fileUrl },
    });

    return {
      success: true,
      pdfUrl: `/api/packets/${packet.id}`,
      version: packet.version,
    };
  } catch (error) {
    console.error("Error generating filing packet PDF:", error);
    return { success: false, error: "Failed to generate filing packet PDF" };
  }
}
