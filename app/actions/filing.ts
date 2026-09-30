"use server";

import { unlink } from "fs/promises";
import path from "path";
import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";

import { createNotification } from "@/app/actions/notifications";
import { generateFilingPacketAction } from "@/app/actions/packet";
import { authOptions } from "@/lib/auth";
import {
  FILING_STATUS,
  getApprovalBlockers,
  getCurrentApprovalState,
  getFinalApprovalBlockers,
  getPipelineStartIndex as getCentralPipelineStartIndex,
} from "@/lib/tax/filing-status";
import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import { getWithholdingDuplicateWarning } from "@/lib/tax/withholding-sources";
import { isSupportedTaxYear } from "@/lib/tax/tax-year-period";
import {
  advanceWizardCompletion,
  clampWizardLocation,
  shrinkWizardCompletion,
} from "@/lib/tax/wizard-completion";
import { isTaxActivitySource } from "@/lib/tax/filing-drafts";
import {
  getTy2026SelectionDetails,
  isTy2026AutomaticIncomeSelection,
  parsePersistedSelectionUserDetails,
  resolveTy2026IncomeSelections,
  type Ty2026IncomeSelectionInput,
  type Ty2026SelectionUserDetails,
} from "@/lib/tax/rules/ty2026/subcategories";

async function getCurrentUserId() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) {
    throw new Error("Unauthorized");
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name: session.user?.name ?? null,
      image: session.user?.image ?? null,
    },
    create: {
      email,
      name: session.user?.name ?? null,
      image: session.user?.image ?? null,
    },
    select: { id: true },
  });

  return user.id;
}

async function getOwnedDraftId(draftId: string, userId: string) {
  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId },
    select: { id: true },
  });

  if (!draft) {
    throw new Error("Filing draft not found");
  }

  return draft.id;
}

type ParsedFilingDraftInput = {
  taxYear: number;
  filerType: string | null;
  businessStructure: string | null;
  salaryPercentage: string | null;
  residencyStatus: "resident" | "non_resident" | null;
  incomeSources: string[];
  incomeSubcategorySelections: Ty2026IncomeSelectionInput[];
  readinessCompleted: string[];
};

function parseFilingDraftInput(
  formData: FormData,
  options: { requireCompleteSubcategories?: boolean } = {},
) {
  const taxYear = Number(formData.get("taxYear"));

  if (!Number.isInteger(taxYear) || !isSupportedTaxYear(taxYear)) {
    return {
      error: "Only Tax Year 2026 is currently supported",
    } as const;
  }

  const filerTypeValue = String(formData.get("filerType") ?? "").trim();
  const businessStructureValue = String(
    formData.get("businessStructure") ?? "",
  ).trim();
  const salaryPercentageValue = String(
    formData.get("salaryPercentage") ?? "",
  ).trim();
  const residencyStatusValue = String(
    formData.get("residencyStatus") ?? "",
  )
    .trim()
    .toLowerCase();
  if (
    residencyStatusValue &&
    residencyStatusValue !== "resident" &&
    residencyStatusValue !== "non_resident"
  ) {
    return {
      error: "Residency status must be Resident or Non-Resident",
    } as const;
  }

  const incomeSources = formData.getAll("incomeSources").map(String);
  const rawSelections: Ty2026IncomeSelectionInput[] = [];
  try {
    for (const value of formData.getAll("incomeSubcategorySelections")) {
      const parsedSelection = JSON.parse(String(value)) as Record<
        string,
        unknown
      >;
      const source = String(parsedSelection.source ?? "").trim();
      const subcategory = String(parsedSelection.subcategory ?? "").trim();
      if (!source || !subcategory) throw new Error("Missing selection fields");
      const details = parsedSelection.details;
      rawSelections.push({
        source,
        subcategory,
        // Shape-validated by resolveTy2026IncomeSelections below; anything
        // out of shape fails the save with a specific error.
        ...(details && typeof details === "object" && !Array.isArray(details)
          ? { details: details as Ty2026SelectionUserDetails }
          : {}),
      });
    }
  } catch {
    return { error: "Income subcategory selections are invalid" } as const;
  }

  if (taxYear !== 2026 && rawSelections.length > 0) {
    return {
      error: "TY2026 subcategories cannot be used for another tax year",
    } as const;
  }

  let normalizedSelections: Ty2026IncomeSelectionInput[] = [];
  if (taxYear === 2026) {
    const resolvedSelections = resolveTy2026IncomeSelections({
      incomeSources,
      selections: rawSelections,
      requireComplete: options.requireCompleteSubcategories ?? false,
    });
    if (!resolvedSelections.success) {
      return { error: resolvedSelections.error } as const;
    }
    normalizedSelections = [...resolvedSelections.selections];
  }

  const parsed: ParsedFilingDraftInput = {
    taxYear,
    filerType: filerTypeValue || null,
    businessStructure: businessStructureValue || null,
    salaryPercentage: salaryPercentageValue || null,
    residencyStatus:
      residencyStatusValue === "resident" ||
      residencyStatusValue === "non_resident"
        ? residencyStatusValue
        : null,
    incomeSources,
    incomeSubcategorySelections: normalizedSelections,
    readinessCompleted: formData.getAll("readinessCompleted").map(String),
  };

  return { value: parsed } as const;
}

function getDocumentsStepIndex(input: ParsedFilingDraftInput) {
  // Centralized helper — single source of truth for pipeline start
  return getCentralPipelineStartIndex({
    filerType: input.filerType,
    businessStructure: input.businessStructure,
    incomeSources: input.incomeSources,
  });
}

function getRequestedStep(formData: FormData) {
  const requestedStep = Number(formData.get("currentStep"));
  return Number.isInteger(requestedStep) && requestedStep >= 0
    ? requestedStep
    : 0;
}

function getRequestedCompletionStep(formData: FormData, fallback: number) {
  const requestedStep = Number(formData.get("wizardCompletionStep"));
  return Number.isInteger(requestedStep) && requestedStep >= 0
    ? requestedStep
    : fallback;
}

async function replaceIncomeSelections(
  tx: Prisma.TransactionClient,
  input: {
    draftId: string;
    userId: string;
    selections: readonly Ty2026IncomeSelectionInput[];
  },
) {
  await tx.filingIncomeSelection.deleteMany({
    where: { filingDraftId: input.draftId, userId: input.userId },
  });

  if (input.selections.length === 0) return;
  await tx.filingIncomeSelection.createMany({
    data: input.selections.map((selection) => ({
      filingDraftId: input.draftId,
      userId: input.userId,
      source: selection.source,
      subcategory: selection.subcategory,
      selectionSource: isTy2026AutomaticIncomeSelection(selection)
        ? "DERIVED"
        : "MANUAL",
      status: "SELECTED",
      detailsJson: JSON.stringify({
        ...(getTy2026SelectionDetails(
          selection.source,
          selection.subcategory,
        ) ?? {}),
        ...(selection.details ? { userDetails: selection.details } : {}),
      }),
    })),
  });
}

async function upsertFilingDraft(
  userId: string,
  input: ParsedFilingDraftInput,
  currentStep: number,
  requestedCompletionStep: number,
  allowCompletionAdvance: boolean,
) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.filingDraft.upsert({
      where: {
        userId_taxYear: {
          userId,
          taxYear: input.taxYear,
        },
      },
      update: {
        filerType: input.filerType,
        businessStructure: input.businessStructure,
        salaryPercentage: input.salaryPercentage,
        residencyStatus: input.residencyStatus,
        incomeSources: JSON.stringify(input.incomeSources),
        readinessChecks: JSON.stringify(input.readinessCompleted),
        currentStep,
        ...(allowCompletionAdvance
          ? { wizardCompletionStep: requestedCompletionStep }
          : {}),
        status: "IN_PROGRESS",
      },
      create: {
        userId,
        taxYear: input.taxYear,
        filerType: input.filerType,
        businessStructure: input.businessStructure,
        salaryPercentage: input.salaryPercentage,
        residencyStatus: input.residencyStatus,
        incomeSources: JSON.stringify(input.incomeSources),
        readinessChecks: JSON.stringify(input.readinessCompleted),
        currentStep,
        wizardCompletionStep: requestedCompletionStep,
        status: "IN_PROGRESS",
      },
    });

    if (!allowCompletionAdvance) {
      // Save Draft may shrink completion after an upstream edit, but it must
      // never re-grow a boundary that a concurrent/earlier reset already cut.
      await tx.filingDraft.updateMany({
        where: {
          id: draft.id,
          wizardCompletionStep: { gt: requestedCompletionStep },
        },
        data: { wizardCompletionStep: requestedCompletionStep },
      });
    }

    await replaceIncomeSelections(tx, {
      draftId: draft.id,
      userId,
      selections: input.incomeSubcategorySelections,
    });
    return draft;
  });
}

export async function getActiveFilingOptionsAction() {
  try {
    const userId = await getCurrentUserId();
    const drafts = await prisma.filingDraft.findMany({
      where: {
        userId,
        // Do not trust APPROVED_FOR_FILING alone here: an old/stale status
        // can exist while the current wizard still needs rules or Mizan.
        status: { not: "FILED" },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        taxYear: true,
        status: true,
        updatedAt: true,
        packetApprovalConfirmed: true,
        taxCalculationStatus: true,
        reconciliationStatus: true,
        reconciliationGap: true,
        filingPackets: {
          where: { status: { not: "SUPERSEDED" } },
          orderBy: { version: "desc" },
          take: 1,
          select: { approvalStatus: true },
        },
      },
    });

    const activeDrafts = (
      await Promise.all(
        drafts.map(async (draft) => {
          const { isCurrentlyApproved } = getCurrentApprovalState({
            draft,
            latestPacket: draft.filingPackets[0] as any,
          });
          if (!isCurrentlyApproved) return draft;

          // A stale raw approval/packet state is not enough to hide a filing
          // from the active dashboard when an account slot is incomplete.
          const [completeness, reconciliation] = await Promise.all([
            validateFilingCompleteness({ draftId: draft.id, userId }),
            validateAuthoritativeReconciliation({
              draftId: draft.id,
              userId,
            }),
          ]);
          return completeness.success && reconciliation.success ? null : draft;
        }),
      )
    ).filter((draft): draft is (typeof drafts)[number] => Boolean(draft));

    return {
      success: true,
      filings: activeDrafts.map(({ filingPackets: _packets, ...draft }) => ({
        ...draft,
        updatedAt: draft.updatedAt.toISOString(),
      })),
    };
  } catch (error) {
    console.error("Error fetching active filing options:", error);
    return {
      success: false,
      error: "Failed to fetch active filings",
      filings: [],
    };
  }
}

export async function createFilingDraftAction(formData: FormData) {
  try {
    const parsedResult = parseFilingDraftInput(formData, {
      requireCompleteSubcategories: true,
    });
    if ("error" in parsedResult) {
      return { success: false, error: parsedResult.error };
    }

    const input = parsedResult.value;
    if (!input.filerType) {
      return { success: false, error: "Select who is filing" };
    }

    if (!input.residencyStatus) {
      return {
        success: false,
        error: "Select Resident or Non-Resident before creating the filing",
      };
    }

    if (input.filerType === "my_business" && !input.businessStructure) {
      return { success: false, error: "Select a business structure" };
    }

    const needsIncomeSourceSelection = Boolean(input.filerType);

    const selectedIncomeSources = input.incomeSources.filter(
      (source) => !isTaxActivitySource(source),
    );
    if (needsIncomeSourceSelection && selectedIncomeSources.length === 0) {
      return { success: false, error: "Select at least one income source" };
    }

    if (
      needsIncomeSourceSelection &&
      selectedIncomeSources.includes("salary") &&
      selectedIncomeSources.length >= 2 &&
      !input.salaryPercentage
    ) {
      return { success: false, error: "Specify the salary share" };
    }

    const userId = await getCurrentUserId();
    const documentsStepIndex = getDocumentsStepIndex(input);
    const draft = await upsertFilingDraft(
      userId,
      input,
      documentsStepIndex,
      documentsStepIndex,
      true,
    );

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/filings");

    return { success: true, draftId: draft.id };
  } catch (error) {
    console.error("Error creating filing draft:", error);
    return { success: false, error: "Failed to create filing draft" };
  }
}

export async function saveFilingDraftAction(formData: FormData) {
  try {
    const parsedResult = parseFilingDraftInput(formData);
    if ("error" in parsedResult) {
      return { success: false, error: parsedResult.error };
    }

    const userId = await getCurrentUserId();
    const requestedStep = getRequestedStep(formData);
    const draft = await upsertFilingDraft(
      userId,
      parsedResult.value,
      requestedStep,
      getRequestedCompletionStep(formData, requestedStep),
      false,
    );

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/filings");

    return { success: true, draftId: draft.id };
  } catch (error) {
    console.error("Error saving filing draft:", error);
    return { success: false, error: "Failed to save filing draft" };
  }
}

export async function confirmFilingForPacketAction(
  draftId: string,
  confirmed: boolean,
  withholdingDuplicateConfirmed = false,
) {
  try {
    if (draftId.startsWith("draft_")) {
      return { success: false, error: "Legacy draft ID not supported" };
    }

    const userId = await getCurrentUserId();
    const ownedDraftId = await getOwnedDraftId(draftId, userId);

    const [draft, activePacket, user] = await Promise.all([
      prisma.filingDraft.findUnique({
        where: { id: ownedDraftId },
        select: {
          taxCalculationStatus: true,
          taxpayerListStatus: true,
          taxRuleSetVersion: true,
          taxCalculationRevision: true,
          reconciliationStatus: true,
          reconciliationGap: true,
          packetApprovalConfirmed: true,
        },
      }),
      prisma.filingPacket.findFirst({
        where: {
          filingDraftId: ownedDraftId,
          userId,
          status: { not: "SUPERSEDED" },
        },
        orderBy: { version: "desc" },
        select: { id: true, approvalStatus: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { practicePreferences: true },
      }),
    ]);

    if (!draft) {
      return { success: false, error: "Filing draft not found" };
    }

    if (confirmed) {
      const [completeness, reconciliation, duplicateWarning] =
        await Promise.all([
          validateFilingCompleteness({ draftId: ownedDraftId, userId }),
          validateAuthoritativeReconciliation({
            draftId: ownedDraftId,
            userId,
          }),
          getWithholdingDuplicateWarning(ownedDraftId, userId),
        ]);
      const blockers = Array.from(
        new Set([
          ...completeness.blockers,
          ...("blockers" in reconciliation ? reconciliation.blockers : []),
          // Re-derived here, never trusted from the client: a direct action
          // call with confirmed=true must face the same question the Review
          // step asked. The persisted approval is the proof of confirmation,
          // and recalculation revokes it, so no column is needed.
          ...(duplicateWarning && !withholdingDuplicateConfirmed
            ? [
                "Confirm on the Review step that the salary-tax ledger rows are separate payments, not the same deduction as the salary certificate",
              ]
            : []),
          ...(["ATL", "NON_ATL", "LATE_FILER"].includes(
            draft.taxpayerListStatus ?? "",
          ) &&
          draft.taxRuleSetVersion &&
          draft.taxCalculationRevision
            ? []
            : ["Calculate a current ATL, Late Filer or Non-ATL tax estimate"]),
          ...getApprovalBlockers({
            taxCalculationStatus: draft.taxCalculationStatus,
            reconciliationStatus: draft.reconciliationStatus,
            reconciliationGap: draft.reconciliationGap,
          }),
        ]),
      );

      if (blockers.length > 0) {
        return { success: false, error: blockers.join(" · ") };
      }
    }

    if (!confirmed && activePacket?.approvalStatus === "APPROVED") {
      return {
        success: false,
        error:
          "Approval is locked for the generated packet. Update filing data to create a new version.",
      };
    }

    await prisma.filingDraft.update({
      where: { id: ownedDraftId },
      data: {
        packetApprovalConfirmed: confirmed,
        packetApprovalAt: confirmed ? new Date() : null,
        packetApprovalByUserId: confirmed ? userId : null,
      },
    });

    // Safe automation: explicit user approval is still required first. This
    // setting only removes the extra Generate Packet click after approval; it
    // can never bypass the approval and validation gates above.
    let autoGeneratedPacket: Awaited<
      ReturnType<typeof generateFilingPacketAction>
    >["packet"];
    if (
      confirmed &&
      (!activePacket || activePacket.approvalStatus !== "APPROVED") &&
      user &&
      (() => {
        try {
          const practice = JSON.parse(user.practicePreferences) as Record<
            string,
            unknown
          >;
          return practice.autoGeneratePackets === true;
        } catch {
          return false;
        }
      })()
    ) {
      const packetResult = await generateFilingPacketAction(ownedDraftId);
      if (!packetResult.success) {
        return {
          success: false,
          error:
            packetResult.error ??
            "Approval saved, but packet generation failed",
        };
      }
      autoGeneratedPacket = packetResult.packet;
    }

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/history");
    revalidatePath("/tax/new");

    return { success: true, packet: autoGeneratedPacket };
  } catch (error) {
    console.error("Error confirming filing for packet:", error);
    return { success: false, error: "Failed to save packet approval" };
  }
}

export async function approveFilingDraftAction(draftId: string) {
  try {
    if (draftId.startsWith("draft_")) {
      return { success: false, error: "Legacy draft ID not supported" };
    }

    const userId = await getCurrentUserId();
    const ownedDraftId = await getOwnedDraftId(draftId, userId);
    const [draft, latestPacket, completeness, reconciliation] =
      await Promise.all([
        prisma.filingDraft.findUnique({
          where: { id: ownedDraftId },
          select: {
            taxYear: true,
            packetApprovalConfirmed: true,
            taxCalculationStatus: true,
            taxpayerListStatus: true,
            taxRuleSetVersion: true,
            taxCalculationRevision: true,
            reconciliationStatus: true,
            reconciliationGap: true,
          },
        }),
        prisma.filingPacket.findFirst({
          where: {
            filingDraftId: ownedDraftId,
            userId,
            status: { not: "SUPERSEDED" },
          },
          orderBy: { version: "desc" },
          select: {
            id: true,
            status: true,
            approvalStatus: true,
            version: true,
          },
        }),
        validateFilingCompleteness({ draftId: ownedDraftId, userId }),
        validateAuthoritativeReconciliation({
          draftId: ownedDraftId,
          userId,
        }),
      ]);

    if (!draft || !latestPacket) {
      return {
        success: false,
        error: "A current filing packet is not available for approval",
      };
    }

    const blockers = Array.from(
      new Set([
        ...completeness.blockers,
        ...("blockers" in reconciliation ? reconciliation.blockers : []),
        ...(["ATL", "NON_ATL", "LATE_FILER"].includes(
          draft.taxpayerListStatus ?? "",
        ) &&
        draft.taxRuleSetVersion &&
        draft.taxCalculationRevision
          ? []
          : ["Calculate a current ATL, Late Filer or Non-ATL tax estimate"]),
        ...getFinalApprovalBlockers({
          packetApprovalConfirmed: draft.packetApprovalConfirmed,
          taxCalculationStatus: draft.taxCalculationStatus,
          reconciliationStatus: draft.reconciliationStatus,
          reconciliationGap: draft.reconciliationGap,
          latestPacket,
        }),
      ]),
    );

    if (blockers.length > 0) {
      return { success: false, error: blockers.join(" · ") };
    }

    const [, updatedDraft] = await prisma.$transaction([
      prisma.filingPacket.update({
        where: { id: latestPacket.id },
        data: {
          approvalStatus: "APPROVED",
          approvedAt: new Date(),
          approvedByUserId: userId,
        },
      }),
      prisma.filingDraft.update({
        where: { id: ownedDraftId },
        data: { status: FILING_STATUS.APPROVED_FOR_FILING },
        select: { taxYear: true },
      }),
    ]);

    await createNotification({
      userId,
      type: "FILING_STATUS",
      title: `Filing approved — Tax Year ${updatedDraft.taxYear}`,
      message: "Your filing packet is approved and ready for FBR Connect.",
      link: `/tax/fbr-connect?draftId=${ownedDraftId}`,
    });

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/history");
    revalidatePath("/tax/fbr-connect");

    return { success: true };
  } catch (error) {
    console.error("Error approving filing draft:", error);
    return { success: false, error: "Failed to approve filing" };
  }
}

export async function invalidateFilingPipelineAction(
  draftId: string,
  resetStep: number,
  preserveReconciliation = false,
) {
  try {
    if (draftId.startsWith("draft_")) {
      return { success: false, error: "Legacy draft ID not supported" };
    }
    if (!Number.isInteger(resetStep) || resetStep < 0) {
      return { success: false, error: "Invalid reset step" };
    }

    const userId = await getCurrentUserId();
    const ownedDraftId = await getOwnedDraftId(draftId, userId);

    await prisma.$transaction(async (tx) => {
      const currentDraft = await tx.filingDraft.findUnique({
        where: { id: ownedDraftId },
        select: { currentStep: true, wizardCompletionStep: true },
      });
      if (!currentDraft) throw new Error("Filing draft not found");

      if (!preserveReconciliation) {
        // Any upstream change invalidates the previous Mizan auto-adjustment.
        // Remove it now so an old OTHER row cannot survive after approval is
        // revoked and contaminate the next reconciliation preview.
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: ownedDraftId,
            userId,
            source: "RECONCILIATION_AUTO_ADJUSTMENT",
          },
        });
      }

      await tx.filingDraft.update({
        where: { id: ownedDraftId },
        data: {
          status: "IN_PROGRESS",
          ...(preserveReconciliation
            ? {}
            : {
                reconciliationStatus: "UNRESOLVED",
                reconciliationMethod: null,
                reconciliationNote: null,
                openingWealth: null,
                closingWealth: null,
                reconciliationGap: null,
              }),
          taxableIncome: null,
          // Keep document-derived withholding credits while invalidating
          // downstream calculations. The mapped salary certificate remains
          // the source of truth for tax deducted; replacing that document
          // updates this field through document mapping.
          taxPayable: null,
          refundDue: null,
          taxCalculationStatus: "NOT_CALCULATED",
          packetApprovalConfirmed: false,
          packetApprovalAt: null,
          packetApprovalByUserId: null,
        },
      });

      // Shrink the boundary only when it is still above this reset point.
      // If another reset already won, do not write its current location back
      // downstream. This makes concurrent edits monotonic and preserves the
      // most restrictive reset boundary.
      await tx.filingDraft.updateMany({
        where: {
          id: ownedDraftId,
          wizardCompletionStep: { gt: resetStep },
        },
        data: {
          currentStep: clampWizardLocation(currentDraft.currentStep, resetStep),
          wizardCompletionStep: resetStep,
        },
      });

      await tx.filingPacket.updateMany({
        where: {
          filingDraftId: ownedDraftId,
          userId,
          status: { not: "SUPERSEDED" },
        },
        data: {
          status: "SUPERSEDED",
          approvalStatus: "SUPERSEDED",
        },
      });

      await tx.fbrConnection.updateMany({
        where: { filingDraftId: ownedDraftId, userId },
        data: {
          status: "NOT_STARTED",
          agentId: null,
          message: null,
          errorMessage: null,
          lastHeartbeat: null,
          startedAt: null,
          completedAt: null,
        },
      });
    });

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/history");
    revalidatePath("/tax/fbr-connect");

    return { success: true };
  } catch (error) {
    console.error("Error invalidating filing pipeline:", error);
    return { success: false, error: "Failed to reset downstream filing steps" };
  }
}

export async function updateFilingStepAction(
  draftId: string,
  newStep: number,
  expectedCompletionStep: number,
) {
  try {
    if (draftId.startsWith("draft_")) {
      return { success: false, error: "Legacy draft ID not supported" };
    }

    if (
      !Number.isInteger(newStep) ||
      newStep < 0 ||
      !Number.isInteger(expectedCompletionStep) ||
      expectedCompletionStep < 0
    ) {
      return { success: false, error: "Invalid filing step" };
    }

    const userId = await getCurrentUserId();
    const ownedDraftId = await getOwnedDraftId(draftId, userId);

    // Read the boundary inside the same transaction as the write. A reset may
    // finish between the draft auto-save and this action; in that case the
    // lower boundary is authoritative and the wizard should resync there, not
    // expose a compare-and-set error to the user. A boundary that is ahead is
    // safe to keep: another tab has simply progressed farther.
    const update = await prisma.$transaction(async (tx) => {
      // Keep the compare-and-set protection, but recover instead of returning
      // the old stale-state error. The conditional write also protects the
      // read from a reset that commits between the read and the write.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentDraft = await tx.filingDraft.findUnique({
          where: { id: ownedDraftId },
          select: { currentStep: true, wizardCompletionStep: true },
        });
        if (!currentDraft) {
          return { success: false as const, error: "Filing draft not found" };
        }

        if (currentDraft.wizardCompletionStep < expectedCompletionStep) {
          const resetStep = currentDraft.wizardCompletionStep;
          const safeCurrentStep = clampWizardLocation(
            currentDraft.currentStep,
            resetStep,
          );
          await tx.filingDraft.updateMany({
            where: {
              id: ownedDraftId,
              wizardCompletionStep: currentDraft.wizardCompletionStep,
            },
            data: { currentStep: safeCurrentStep },
          });
          return {
            success: true as const,
            resynced: true as const,
            resetStep,
            completionStep: resetStep,
          };
        }

        const completionStep = advanceWizardCompletion(
          currentDraft.wizardCompletionStep,
          newStep,
        );
        const write = await tx.filingDraft.updateMany({
          where: {
            id: ownedDraftId,
            wizardCompletionStep: currentDraft.wizardCompletionStep,
          },
          data: {
            currentStep: newStep,
            wizardCompletionStep: completionStep,
          },
        });
        if (write.count === 1) {
          return { success: true as const, completionStep };
        }
        // A concurrent reset or forward navigation changed the boundary.
        // Re-read it and handle the new authoritative value on the next pass.
      }

      // The short retry loop is intentionally user-safe: if another request
      // keeps moving the boundary, resync to the latest persisted location
      // rather than showing a stale compare-and-set error.
      const latestDraft = await tx.filingDraft.findUnique({
        where: { id: ownedDraftId },
        select: { currentStep: true, wizardCompletionStep: true },
      });
      if (!latestDraft) {
        return { success: false as const, error: "Filing draft not found" };
      }
      const resetStep = Math.min(
        latestDraft.currentStep,
        latestDraft.wizardCompletionStep,
      );
      return {
        success: true as const,
        resynced: true as const,
        resetStep,
        completionStep: latestDraft.wizardCompletionStep,
      };
    });

    if (!update.success) return update;

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/filings");

    return update;
  } catch (error) {
    console.error("Error updating filing step:", error);
    return { success: false, error: "Failed to update step" };
  }
}

export async function deleteFilingDraftAction(draftId: string) {
  try {
    const userId = await getCurrentUserId();
    const draft = await prisma.filingDraft.findFirst({
      where: { id: draftId, userId },
      select: {
        id: true,
        status: true,
        documents: { select: { fileUrl: true } },
        filingPackets: { select: { fileUrl: true, approvalStatus: true } },
        fbrConnections: { select: { status: true } },
      },
    });

    if (!draft) return { success: false, error: "Filing draft not found" };
    if (
      draft.status === FILING_STATUS.FILED ||
      draft.status === FILING_STATUS.APPROVED_FOR_FILING ||
      draft.filingPackets.some((packet) => packet.approvalStatus === "APPROVED")
    ) {
      return {
        success: false,
        error: "Approved or filed returns cannot be deleted",
      };
    }
    if (
      draft.fbrConnections.some((connection) =>
        ["WAITING_FOR_AGENT", "CONNECTED", "SUBMITTING"].includes(
          connection.status,
        ),
      )
    ) {
      return {
        success: false,
        error: "Cancel the active FBR connection before deleting this draft",
      };
    }

    const files = [
      ...draft.documents.map((document) => document.fileUrl),
      ...draft.filingPackets.map((packet) => packet.fileUrl),
    ].filter((fileUrl): fileUrl is string => Boolean(fileUrl));

    // Relations in the Prisma schema cascade from FilingDraft. Files on the
    // local filesystem need explicit cleanup as they are not database rows.
    await prisma.filingDraft.delete({ where: { id: draft.id } });
    await Promise.all(
      files.map((fileUrl) => {
        // Stored paths are relative and may include a subdirectory, such as
        // "packets/<id>.pdf". Taking only the basename looked in the wrong
        // directory, so packet PDFs survived every draft deletion and
        // accumulated on disk. Normalise instead, and refuse anything that
        // escapes the uploads root.
        const relativePath = path.normalize(fileUrl);
        if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
          return Promise.resolve();
        }
        return unlink(path.join(process.cwd(), "uploads", relativePath)).catch(
          () => undefined,
        );
      }),
    );

    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/history");
    revalidatePath("/tax/new");
    return { success: true };
  } catch (error) {
    console.error("Error deleting filing draft:", error);
    return { success: false, error: "Failed to delete filing draft" };
  }
}

export async function getFilingDraftAction(draftId: string) {
  try {
    if (draftId.startsWith("draft_")) {
      return { success: false, error: "Legacy draft ID not supported" };
    }

    const userId = await getCurrentUserId();
    const draft = await prisma.filingDraft.findFirst({
      where: { id: draftId, userId },
      include: {
        incomeSelections: {
          where: { status: "SELECTED" },
          orderBy: [{ source: "asc" }, { subcategory: "asc" }],
          select: { source: true, subcategory: true, detailsJson: true },
        },
      },
    });

    if (!draft) return { success: false, error: "Not found" };

    const { incomeSelections, ...draftFields } = draft;
    return {
      success: true,
      draft: {
        ...draftFields,
        incomeSources: JSON.parse(draft.incomeSources),
        // Declared figures travel back so resume never wipes them: the
        // wizard re-saves the hydrated state on the next auto-save.
        incomeSubcategorySelections: incomeSelections.map((selection) => {
          const details = parsePersistedSelectionUserDetails(
            selection.detailsJson,
          );
          return {
            source: selection.source,
            subcategory: selection.subcategory,
            ...(details ? { details } : {}),
          };
        }),
        readinessCompleted: JSON.parse(draft.readinessChecks),
      },
    };
  } catch (error) {
    console.error("Error fetching filing draft:", error);
    return { success: false, error: "Failed to fetch draft" };
  }
}

export type FilingDraftUpdateInput = Readonly<{
  taxYear?: number;
  filerType?: string | null;
  businessStructure?: string | null;
  salaryPercentage?: string | null;
  residencyStatus?: "resident" | "non_resident" | null;
  currentStep?: number;
  wizardCompletionStep?: number;
  incomeSources?: string[];
  incomeSubcategorySelections?: Ty2026IncomeSelectionInput[];
  readinessCompleted?: string[];
}>;

export async function updateFilingDraftAction(
  draftId: string,
  formData: FilingDraftUpdateInput,
) {
  try {
    if (draftId.startsWith("draft_")) {
      return { success: false, error: "Legacy draft ID not supported" };
    }

    const dataToUpdate: {
      taxYear?: number;
      filerType?: string | null;
      businessStructure?: string | null;
      salaryPercentage?: string | null;
      residencyStatus?: "resident" | "non_resident" | null;
      currentStep?: number;
      wizardCompletionStep?: number;
      incomeSources?: string;
      readinessChecks?: string;
    } = {};

    if (formData.taxYear !== undefined) {
      if (
        !Number.isInteger(formData.taxYear) ||
        !isSupportedTaxYear(formData.taxYear)
      ) {
        return {
          success: false,
          error: "Only Tax Year 2026 is currently supported",
        };
      }
      dataToUpdate.taxYear = formData.taxYear;
    }

    if (formData.filerType !== undefined) {
      dataToUpdate.filerType = formData.filerType || null;
    }
    if (formData.businessStructure !== undefined) {
      dataToUpdate.businessStructure = formData.businessStructure || null;
    }
    if (formData.salaryPercentage !== undefined) {
      dataToUpdate.salaryPercentage = formData.salaryPercentage || null;
    }
    if (formData.residencyStatus !== undefined) {
      if (
        formData.residencyStatus !== null &&
        formData.residencyStatus !== "resident" &&
        formData.residencyStatus !== "non_resident"
      ) {
        return {
          success: false,
          error: "Residency status must be Resident or Non-Resident",
        };
      }
      dataToUpdate.residencyStatus = formData.residencyStatus || null;
    }
    if (formData.currentStep !== undefined) {
      if (!Number.isInteger(formData.currentStep) || formData.currentStep < 0) {
        return { success: false, error: "Invalid filing step" };
      }
      dataToUpdate.currentStep = formData.currentStep;
    }
    if (
      formData.wizardCompletionStep !== undefined &&
      (!Number.isInteger(formData.wizardCompletionStep) ||
        formData.wizardCompletionStep < 0)
    ) {
      return { success: false, error: "Invalid wizard completion step" };
    }
    if (formData.incomeSources !== undefined) {
      if (formData.incomeSubcategorySelections === undefined) {
        return {
          success: false,
          error: "Income source updates must include TY2026 subcategories",
        };
      }
      dataToUpdate.incomeSources = JSON.stringify(formData.incomeSources);
    }
    if (formData.readinessCompleted !== undefined) {
      dataToUpdate.readinessChecks = JSON.stringify(
        formData.readinessCompleted,
      );
    }

    const userId = await getCurrentUserId();
    const ownedDraftId = await getOwnedDraftId(draftId, userId);
    const currentDraft = await prisma.filingDraft.findUnique({
      where: { id: ownedDraftId },
      select: {
        taxYear: true,
        residencyStatus: true,
        wizardCompletionStep: true,
        incomeSources: true,
        incomeSelections: {
          where: { status: "SELECTED" },
          select: { source: true, subcategory: true, detailsJson: true },
        },
      },
    });
    if (!currentDraft) {
      return { success: false, error: "Filing draft not found" };
    }

    let resolvedSelections: Ty2026IncomeSelectionInput[] | undefined;
    if (formData.incomeSubcategorySelections !== undefined) {
      const effectiveTaxYear = formData.taxYear ?? currentDraft.taxYear;
      const effectiveIncomeSources =
        formData.incomeSources ??
        (() => {
          try {
            const parsed = JSON.parse(currentDraft.incomeSources);
            return Array.isArray(parsed) ? parsed.map(String) : [];
          } catch {
            return [];
          }
        })();

      if (effectiveTaxYear !== 2026) {
        if (formData.incomeSubcategorySelections.length > 0) {
          return {
            success: false,
            error: "TY2026 subcategories cannot be used for another tax year",
          };
        }
        resolvedSelections = [];
      } else {
        const resolved = resolveTy2026IncomeSelections({
          incomeSources: effectiveIncomeSources,
          selections: formData.incomeSubcategorySelections,
          // Draft auto-save and step navigation must allow an incomplete
          // future category step. Review/Create performs the strict check.
          requireComplete: false,
        });
        if (!resolved.success) {
          return { success: false, error: resolved.error };
        }
        resolvedSelections = resolved.selections;
      }
    }

    // Declared figures are part of the classification: editing a bill, a
    // vehicle value or a split must invalidate downstream results exactly
    // like swapping the category itself.
    const fingerprintDetails = (details?: Ty2026SelectionUserDetails) =>
      details
        ? Object.keys(details)
            .sort()
            .map(
              (key) =>
                `${key}=${details[key as keyof Ty2026SelectionUserDetails]}`,
            )
            .join(",")
        : "";
    const selectionKeys = (selections: readonly Ty2026IncomeSelectionInput[]) =>
      selections
        .map(
          (selection) =>
            `${selection.source}\u0000${selection.subcategory}\u0000${fingerprintDetails(selection.details)}`,
        )
        .sort();
    const previousSelections: Ty2026IncomeSelectionInput[] =
      currentDraft.incomeSelections.map((selection) => {
        const details = parsePersistedSelectionUserDetails(
          selection.detailsJson,
        );
        return {
          source: selection.source,
          subcategory: selection.subcategory,
          ...(details ? { details } : {}),
        };
      });
    const previousSelectionKeys = selectionKeys(previousSelections);
    const nextSelectionKeys =
      resolvedSelections === undefined
        ? previousSelectionKeys
        : selectionKeys(resolvedSelections);
    const selectionsChanged =
      previousSelectionKeys.length !== nextSelectionKeys.length ||
      previousSelectionKeys.some(
        (selectionKey, index) => selectionKey !== nextSelectionKeys[index],
      );
    const previousIncomeSources = (() => {
      try {
        const parsed = JSON.parse(currentDraft.incomeSources);
        return Array.isArray(parsed) ? parsed.map(String).sort() : [];
      } catch {
        return [];
      }
    })();
    const nextIncomeSources = (formData.incomeSources ?? previousIncomeSources)
      .slice()
      .sort();
    const sourcesChanged =
      previousIncomeSources.length !== nextIncomeSources.length ||
      previousIncomeSources.some(
        (source, index) => source !== nextIncomeSources[index],
      );
    const residencyChanged =
      formData.residencyStatus !== undefined &&
      formData.residencyStatus !== currentDraft.residencyStatus;
    const classificationChanged =
      selectionsChanged || sourcesChanged || residencyChanged;
    // Auto-save may race with the explicit pipeline invalidation request.
    // Never put the completion boundary in the ordinary update below: an old
    // request could otherwise write a stale, larger value after a reset. The
    // boundary/current-step write is done later with a guarded updateMany.
    const requestedCompletionReset =
      formData.wizardCompletionStep ??
      (classificationChanged ? formData.currentStep : undefined);
    const currentStepToSave = dataToUpdate.currentStep;
    if (requestedCompletionReset !== undefined) {
      delete dataToUpdate.currentStep;
      delete dataToUpdate.wizardCompletionStep;
    }

    await prisma.$transaction(async (tx) => {
      await tx.filingDraft.update({
        where: { id: ownedDraftId },
        data: dataToUpdate,
      });
      if (resolvedSelections !== undefined) {
        await replaceIncomeSelections(tx, {
          draftId: ownedDraftId,
          userId,
          selections: resolvedSelections,
        });
      }

      if (classificationChanged) {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: ownedDraftId,
            userId,
            source: "RECONCILIATION_AUTO_ADJUSTMENT",
          },
        });
        await tx.filingDraft.update({
          where: { id: ownedDraftId },
          data: {
            status: "IN_PROGRESS",
            reconciliationStatus: "UNRESOLVED",
            reconciliationMethod: null,
            reconciliationNote: null,
            openingWealth: null,
            closingWealth: null,
            reconciliationGap: null,
            taxableIncome: null,
            taxPayable: null,
            refundDue: null,
            taxCalculationStatus: "NOT_CALCULATED",
            packetApprovalConfirmed: false,
            packetApprovalAt: null,
            packetApprovalByUserId: null,
          },
        });
        await tx.filingPacket.updateMany({
          where: {
            filingDraftId: ownedDraftId,
            userId,
            status: { not: "SUPERSEDED" },
          },
          data: {
            status: "SUPERSEDED",
            approvalStatus: "SUPERSEDED",
          },
        });
        await tx.fbrConnection.updateMany({
          where: { filingDraftId: ownedDraftId, userId },
          data: {
            status: "NOT_STARTED",
            agentId: null,
            message: null,
            errorMessage: null,
            lastHeartbeat: null,
            startedAt: null,
            completedAt: null,
          },
        });
      }

      if (requestedCompletionReset !== undefined) {
        // A classification/document edit may request a reset at the current
        // step. If another reset already lowered the boundary, this condition
        // fails and the later request cannot move the boundary or location
        // back downstream.
        const resetTarget = Math.min(
          currentDraft.wizardCompletionStep,
          requestedCompletionReset,
          classificationChanged
            ? (formData.currentStep ?? currentDraft.wizardCompletionStep)
            : currentDraft.wizardCompletionStep,
        );
        const guardedCurrentStep =
          currentStepToSave === undefined
            ? undefined
            : clampWizardLocation(currentStepToSave, resetTarget);

        if (resetTarget < currentDraft.wizardCompletionStep) {
          await tx.filingDraft.updateMany({
            where: {
              id: ownedDraftId,
              wizardCompletionStep: { gt: resetTarget },
            },
            data: {
              wizardCompletionStep: resetTarget,
              ...(guardedCurrentStep === undefined
                ? {}
                : { currentStep: guardedCurrentStep }),
            },
          });
        } else if (currentStepToSave !== undefined) {
          // Ordinary Back navigation still persists the location, but only if
          // the boundary is the one read at the start of this request. A
          // concurrent reset then wins without being overwritten.
          await tx.filingDraft.updateMany({
            where: {
              id: ownedDraftId,
              wizardCompletionStep: currentDraft.wizardCompletionStep,
            },
            data: {
              currentStep: clampWizardLocation(
                currentStepToSave,
                currentDraft.wizardCompletionStep,
              ),
            },
          });
        }
      }
    });

    return { success: true };
  } catch (error) {
    console.error("Error updating draft:", error);
    return { success: false, error: "Failed to update draft" };
  }
}
