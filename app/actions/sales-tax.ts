"use server";

import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import type { Prisma } from "@prisma/client";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  analyzeUploads,
  isUploadKind,
  type UploadKind,
} from "@/lib/sales-tax/analyze-uploads";
import {
  buildApprovalPacket,
  buildEstimate,
  checkCapitalRows,
  fingerprintOf,
  isApprovalCurrent,
  type FileSummary,
} from "@/lib/sales-tax/estimate";
import {
  parseStoredFigures,
  validateFiguresForm,
  type ReturnFigures,
} from "@/lib/sales-tax/figures";
import type { CellGrid } from "@/lib/sales-tax/template-reader";
import type { ReturnResult, SalesTaxProblem } from "@/lib/sales-tax/types";
import {
  MAX_UPLOAD_BYTES,
  readInvoiceWorkbook,
} from "@/lib/sales-tax/workbook";
import { getDueDates } from "@/lib/sales-tax/rules/fbr-goods/due-dates";
import {
  parseStoredAuthorities,
  validateProfile,
  validateRequestedPeriod,
  type AuthorityCode,
} from "@/lib/sales-tax/profile";

// The Sales Tax module is separate from the income-tax filing journey: it has
// its own tables (SalesTaxProfile, SalesTaxFiling) and never touches
// FilingDraft.

const STATUS_DRAFT = "DRAFT";

async function getCurrentUserId() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: session.user?.name ?? null,
      image: session.user?.image ?? null,
    },
    select: { id: true },
  });
  return user.id;
}

export type SalesTaxFilingSummary = {
  id: string;
  authority: string;
  periodYear: number;
  periodMonth: number;
  status: string;
  updatedAt: string;
  dueDates: {
    annexC: string;
    payment: string;
    returnFiling: string;
  } | null;
};

function toSummary(row: {
  id: string;
  authority: string;
  periodYear: number;
  periodMonth: number;
  status: string;
  updatedAt: Date;
}): SalesTaxFilingSummary {
  // Only FBR due dates are known today; other authorities get theirs with
  // their own phases.
  const due =
    row.authority === "FBR"
      ? getDueDates({ year: row.periodYear, month: row.periodMonth })
      : null;
  return {
    id: row.id,
    authority: row.authority,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    dueDates: due
      ? {
          annexC: due.annexC,
          payment: due.payment,
          returnFiling: due.returnFiling,
        }
      : null,
  };
}

export async function getSalesTaxOverviewAction() {
  try {
    const userId = await getCurrentUserId();
    const [profile, filings] = await Promise.all([
      prisma.salesTaxProfile.findUnique({ where: { userId } }),
      prisma.salesTaxFiling.findMany({
        where: { userId },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { authority: "asc" }],
      }),
    ]);
    return {
      success: true as const,
      profile: profile
        ? {
            businessName: profile.businessName,
            registrationNo: profile.registrationNo,
            authorities: parseStoredAuthorities(profile.authorities),
          }
        : null,
      filings: filings.map(toSummary),
    };
  } catch (error) {
    console.error("Error loading the sales tax overview:", error);
    return {
      success: false as const,
      error: "Could not load your sales tax details. Please refresh the page.",
      profile: null,
      filings: [] as SalesTaxFilingSummary[],
    };
  }
}

export async function saveSalesTaxProfileAction(input: {
  businessName: string;
  registrationNo: string;
  authorities: string[];
}) {
  try {
    const checked = validateProfile(input);
    if (checked.ok === false) return { success: false as const, error: checked.error };

    const userId = await getCurrentUserId();
    const { businessName, registrationNo, authorities } = checked.value;
    await prisma.salesTaxProfile.upsert({
      where: { userId },
      update: {
        businessName,
        registrationNo,
        authorities: JSON.stringify(authorities),
      },
      create: {
        userId,
        businessName,
        registrationNo,
        authorities: JSON.stringify(authorities),
      },
    });
    revalidatePath("/tax/sales-tax");
    return { success: true as const };
  } catch (error) {
    console.error("Error saving the sales tax profile:", error);
    return {
      success: false as const,
      error: "Could not save your business details. Please try again.",
    };
  }
}

export async function startSalesTaxMonthAction(input: {
  authority: string;
  year: number;
  month: number;
}) {
  try {
    const userId = await getCurrentUserId();
    const profile = await prisma.salesTaxProfile.findUnique({ where: { userId } });
    if (!profile) {
      return {
        success: false as const,
        error: "Save your business details first, then start a month.",
      };
    }

    const authority = String(input.authority ?? "");
    const allowed = parseStoredAuthorities(profile.authorities);
    if (!allowed.includes(authority as AuthorityCode)) {
      return {
        success: false as const,
        error: "Choose one of the authorities saved in your business details.",
      };
    }

    const period = validateRequestedPeriod(input.year, input.month);
    if (period.ok === false) return { success: false as const, error: period.error };

    // One return per authority per month: starting it again opens the same one.
    const where = {
      userId_authority_periodYear_periodMonth: {
        userId,
        authority,
        periodYear: period.value.year,
        periodMonth: period.value.month,
      },
    };
    const existing = await prisma.salesTaxFiling.findUnique({ where });
    if (existing) {
      return { success: true as const, id: existing.id, alreadyExisted: true };
    }

    try {
      const created = await prisma.salesTaxFiling.create({
        data: {
          userId,
          authority,
          periodYear: period.value.year,
          periodMonth: period.value.month,
          status: STATUS_DRAFT,
        },
      });
      revalidatePath("/tax/sales-tax");
      return { success: true as const, id: created.id, alreadyExisted: false };
    } catch (error) {
      // Two clicks at once: the unique key stops the second insert. Return the
      // row the first click created.
      const winner = await prisma.salesTaxFiling.findUnique({ where });
      if (winner) {
        return { success: true as const, id: winner.id, alreadyExisted: true };
      }
      throw error;
    }
  } catch (error) {
    console.error("Error starting the sales tax month:", error);
    return {
      success: false as const,
      error: "Could not start this month. Please try again.",
    };
  }
}

export async function deleteSalesTaxMonthAction(filingId: string) {
  try {
    const userId = await getCurrentUserId();
    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId },
      select: { id: true, status: true },
    });
    if (!filing) {
      return { success: false as const, error: "This month was not found." };
    }
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Only a draft month can be deleted.",
      };
    }
    await prisma.salesTaxFiling.delete({ where: { id: filing.id } });
    revalidatePath("/tax/sales-tax");
    return { success: true as const };
  } catch (error) {
    console.error("Error deleting the sales tax month:", error);
    return {
      success: false as const,
      error: "Could not delete this month. Please try again.",
    };
  }
}

export type SalesTaxUploadInfo = {
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  invoiceCount: number;
  /** Totals in paisa. */
  valuePaisa: number;
  taxPaisa: number;
};

export type SalesTaxInvoiceState = {
  sales: SalesTaxUploadInfo | null;
  purchases: SalesTaxUploadInfo | null;
  problems: SalesTaxProblem[];
};

type StoredUpload = {
  kind: string;
  fileName: string;
  fileSize: number;
  updatedAt: Date;
  grid: unknown;
};

/** Reads the stored files and runs every file check on them again. */
function buildInvoiceState(
  period: { year: number; month: number },
  registrationNo: string,
  uploads: StoredUpload[],
): SalesTaxInvoiceState {
  const sales = uploads.find((upload) => upload.kind === "SALES");
  const purchases = uploads.find((upload) => upload.kind === "PURCHASES");
  const analysis = analyzeUploads({
    registrationNo,
    period,
    salesGrid: sales ? (sales.grid as CellGrid) : null,
    purchaseGrid: purchases ? (purchases.grid as CellGrid) : null,
  });
  const info = (
    upload: StoredUpload | undefined,
    stats: typeof analysis.sales,
  ): SalesTaxUploadInfo | null =>
    upload && stats
      ? {
          fileName: upload.fileName,
          fileSize: upload.fileSize,
          uploadedAt: upload.updatedAt.toISOString(),
          invoiceCount: stats.invoiceCount,
          valuePaisa: stats.valuePaisa,
          taxPaisa: stats.taxPaisa,
        }
      : null;
  return {
    sales: info(sales, analysis.sales),
    purchases: info(purchases, analysis.purchases),
    problems: analysis.problems,
  };
}

export type SalesTaxReview = {
  figures: ReturnFigures;
  /** The estimate. Its problems are the return-level ones; file problems are in `invoices`. */
  estimate: ReturnResult;
  /** How many must-fix problems in the invoice files stop the estimate. */
  fileProblemsBlocking: number;
  approval: { approvedAt: string; current: boolean } | null;
};

const FILE_SHEETS = new Set(["sales", "purchases", "template"]);

type FilingForReview = {
  authority: string;
  periodYear: number;
  periodMonth: number;
  figures: unknown;
  approvedAt: Date | null;
  approvedPacket: unknown;
  uploads: StoredUpload[];
};

function fileSummary(info: SalesTaxUploadInfo | null): FileSummary | null {
  return info
    ? {
        fileName: info.fileName,
        invoiceCount: info.invoiceCount,
        valuePaisa: info.valuePaisa,
        taxPaisa: info.taxPaisa,
      }
    : null;
}

/** Estimate, approval state and the approval fingerprint for one month. */
function computeReview(
  filing: FilingForReview,
  figures: ReturnFigures,
  registrationNo: string,
) {
  const period = { year: filing.periodYear, month: filing.periodMonth };
  const sales = filing.uploads.find((upload) => upload.kind === "SALES");
  const purchases = filing.uploads.find((upload) => upload.kind === "PURCHASES");
  const result = buildEstimate({
    registrationNo,
    period,
    salesGrid: sales ? (sales.grid as CellGrid) : null,
    purchaseGrid: purchases ? (purchases.grid as CellGrid) : null,
    figures,
  });
  const invoices = buildInvoiceState(period, registrationNo, filing.uploads);
  const files = {
    sales: fileSummary(invoices.sales),
    purchases: fileSummary(invoices.purchases),
  };
  const fingerprint = fingerprintOf({ period, registrationNo, figures, files, result });
  const review: SalesTaxReview = {
    figures,
    estimate: {
      ...result,
      problems: result.problems.filter((problem) => !FILE_SHEETS.has(problem.sheet)),
    },
    fileProblemsBlocking: result.problems.filter(
      (problem) => FILE_SHEETS.has(problem.sheet) && problem.severity !== "warning",
    ).length,
    approval: filing.approvedAt
      ? {
          approvedAt: filing.approvedAt.toISOString(),
          current: isApprovalCurrent(filing.approvedPacket, { fingerprint }),
        }
      : null,
  };
  return { review, result, files, fingerprint, period };
}

export async function getSalesTaxFilingAction(filingId: string) {
  try {
    const userId = await getCurrentUserId();
    const [filing, profile] = await Promise.all([
      prisma.salesTaxFiling.findFirst({
        where: { id: String(filingId ?? ""), userId },
        include: {
          uploads: {
            select: {
              kind: true,
              fileName: true,
              fileSize: true,
              updatedAt: true,
              grid: true,
            },
          },
        },
      }),
      prisma.salesTaxProfile.findUnique({ where: { userId } }),
    ]);
    if (!filing) return { success: false as const, error: "This month was not found." };
    return {
      success: true as const,
      filing: toSummary(filing),
      profile: profile
        ? {
            businessName: profile.businessName,
            registrationNo: profile.registrationNo,
          }
        : null,
      invoices: buildInvoiceState(
        { year: filing.periodYear, month: filing.periodMonth },
        profile?.registrationNo ?? "",
        filing.uploads,
      ),
      review: computeReview(
        filing,
        parseStoredFigures(filing.figures),
        profile?.registrationNo ?? "",
      ).review,
    };
  } catch (error) {
    console.error("Error loading the sales tax month:", error);
    return {
      success: false as const,
      error: "Could not load this month. Please try again.",
    };
  }
}

const ALLOWED_EXTENSION = /\.(xlsx|xlsm)$/i;

/**
 * Saves one invoice file (sales or purchases) for a month. A file that cannot
 * be read safely is refused and nothing is stored, so the file already saved
 * for that month stays as it was.
 */
export async function uploadSalesTaxInvoicesAction(formData: FormData) {
  try {
    const userId = await getCurrentUserId();
    const filingId = String(formData.get("filingId") ?? "");
    const kind = formData.get("kind");
    const file = formData.get("file");

    if (!isUploadKind(kind)) {
      return { success: false as const, error: "Choose whether this is the sales or the purchases file." };
    }
    if (!(file instanceof File) || file.size === 0) {
      return { success: false as const, error: "Choose an Excel file to upload." };
    }
    if (!ALLOWED_EXTENSION.test(file.name)) {
      return {
        success: false as const,
        error: "Upload the invoice template as an Excel file (.xlsx or .xlsm).",
      };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return {
        success: false as const,
        error: `This file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Remove empty rows or split the month into smaller files.`,
      };
    }

    const [filing, profile] = await Promise.all([
      prisma.salesTaxFiling.findFirst({
        where: { id: filingId, userId },
        select: { id: true, status: true, periodYear: true, periodMonth: true },
      }),
      prisma.salesTaxProfile.findUnique({ where: { userId } }),
    ]);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Files can only be changed while the month is a draft." };
    }
    if (!profile) {
      return { success: false as const, error: "Save your business details first, then upload your invoices." };
    }

    const opened = await readInvoiceWorkbook(new Uint8Array(await file.arrayBuffer()));
    if (opened.ok === false) return { success: false as const, error: opened.error };

    const period = { year: filing.periodYear, month: filing.periodMonth };
    const check = analyzeUploads({
      registrationNo: profile.registrationNo,
      period,
      salesGrid: kind === "SALES" ? opened.grid : null,
      purchaseGrid: kind === "PURCHASES" ? opened.grid : null,
    });
    const stats = kind === "SALES" ? check.sales : check.purchases;
    if (!stats || !stats.readable) {
      const first = check.problems[0];
      return {
        success: false as const,
        error: first
          ? `${first.message} ${first.action}`
          : "This file could not be read. Use the invoice template from IRIS.",
      };
    }

    const data = {
      fileName: file.name.slice(0, 200),
      fileSize: file.size,
      rowCount: stats.invoiceCount,
      grid: opened.grid as unknown as Prisma.InputJsonValue,
    };
    await prisma.salesTaxUpload.upsert({
      where: { filingId_kind: { filingId: filing.id, kind } },
      update: data,
      create: { filingId: filing.id, kind, ...data },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const uploads = await prisma.salesTaxUpload.findMany({
      where: { filingId: filing.id },
      select: { kind: true, fileName: true, fileSize: true, updatedAt: true, grid: true },
    });
    return {
      success: true as const,
      invoices: buildInvoiceState(period, profile.registrationNo, uploads),
    };
  } catch (error) {
    console.error("Error saving the sales tax invoice file:", error);
    return {
      success: false as const,
      error: "Could not save this file. Please try again.",
    };
  }
}

export async function removeSalesTaxUploadAction(filingId: string, kind: UploadKind) {
  try {
    const userId = await getCurrentUserId();
    if (!isUploadKind(kind)) {
      return { success: false as const, error: "Choose whether this is the sales or the purchases file." };
    }
    const [filing, profile] = await Promise.all([
      prisma.salesTaxFiling.findFirst({
        where: { id: String(filingId ?? ""), userId },
        select: { id: true, status: true, periodYear: true, periodMonth: true },
      }),
      prisma.salesTaxProfile.findUnique({ where: { userId } }),
    ]);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Files can only be changed while the month is a draft." };
    }
    await prisma.salesTaxUpload.deleteMany({ where: { filingId: filing.id, kind } });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const uploads = await prisma.salesTaxUpload.findMany({
      where: { filingId: filing.id },
      select: { kind: true, fileName: true, fileSize: true, updatedAt: true, grid: true },
    });
    return {
      success: true as const,
      invoices: buildInvoiceState(
        { year: filing.periodYear, month: filing.periodMonth },
        profile?.registrationNo ?? "",
        uploads,
      ),
    };
  } catch (error) {
    console.error("Error removing the sales tax invoice file:", error);
    return {
      success: false as const,
      error: "Could not remove this file. Please try again.",
    };
  }
}

/** Loads one of the user's months with its files and the business profile. */
async function loadMonthForReview(userId: string, filingId: string) {
  const [filing, profile] = await Promise.all([
    prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId },
      include: {
        uploads: {
          select: { kind: true, fileName: true, fileSize: true, updatedAt: true, grid: true },
        },
      },
    }),
    prisma.salesTaxProfile.findUnique({ where: { userId } }),
  ]);
  return { filing, profile };
}

/**
 * Saves the figures that are not in the invoice files and returns the fresh
 * estimate. Invalid figures are refused and nothing is stored.
 */
export async function saveSalesTaxFiguresAction(filingId: string, form: unknown) {
  try {
    const userId = await getCurrentUserId();
    const { filing, profile } = await loadMonthForReview(userId, filingId);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Figures can only be changed while the month is a draft." };
    }
    if (!profile) {
      return { success: false as const, error: "Save your business details first." };
    }
    const checked = validateFiguresForm(form);
    if (checked.ok === false) return { success: false as const, error: checked.error };

    const purchases = filing.uploads.find((upload) => upload.kind === "PURCHASES");
    const capitalProblem = checkCapitalRows(
      purchases ? (purchases.grid as CellGrid) : null,
      checked.value.capitalGoodsRows,
    );
    if (capitalProblem) return { success: false as const, error: capitalProblem };

    await prisma.salesTaxFiling.update({
      where: { id: filing.id },
      data: { figures: checked.value as unknown as Prisma.InputJsonValue },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const { review } = computeReview(filing, checked.value, profile.registrationNo);
    return { success: true as const, review };
  } catch (error) {
    console.error("Error saving the sales tax figures:", error);
    return {
      success: false as const,
      error: "Could not save your figures. Please try again.",
    };
  }
}

/**
 * Approves the estimate the user has just reviewed. The estimate is worked
 * out again here, so only what the server computes can be approved. Nothing
 * is sent to FBR.
 */
export async function approveSalesTaxReturnAction(filingId: string, confirmed: boolean) {
  try {
    if (confirmed !== true) {
      return {
        success: false as const,
        error: "Tick the box to confirm that you have reviewed the return.",
      };
    }
    const userId = await getCurrentUserId();
    const { filing, profile } = await loadMonthForReview(userId, filingId);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Only a draft return can be approved." };
    }
    if (!profile) {
      return { success: false as const, error: "Save your business details first." };
    }
    const figures = parseStoredFigures(filing.figures);
    const now = computeReview(filing, figures, profile.registrationNo);
    const built = buildApprovalPacket({
      approvedAt: new Date(),
      authority: filing.authority,
      period: now.period,
      businessName: profile.businessName,
      registrationNo: profile.registrationNo,
      figures,
      files: now.files,
      result: now.result,
    });
    if (built.ok === false) return { success: false as const, error: built.error };

    const updated = await prisma.salesTaxFiling.update({
      where: { id: filing.id },
      data: {
        approvedAt: new Date(built.packet.approvedAt),
        approvedPacket: built.packet as unknown as Prisma.InputJsonValue,
      },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const { review } = computeReview(
      { ...filing, approvedAt: updated.approvedAt, approvedPacket: updated.approvedPacket },
      figures,
      profile.registrationNo,
    );
    return { success: true as const, review };
  } catch (error) {
    console.error("Error approving the sales tax return:", error);
    return {
      success: false as const,
      error: "Could not approve this return. Please try again.",
    };
  }
}
