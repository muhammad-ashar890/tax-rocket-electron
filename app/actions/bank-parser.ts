"use server";

import { readFile } from "fs/promises";
import path from "path";
// The `xlsx` package on npm is abandoned at 0.18.5 and carries an unfixed
// prototype-pollution advisory (CVE-2023-30533) that is reachable here,
// because this parser reads spreadsheets uploaded by users. @e965/xlsx is the
// maintained community fork of the same SheetJS codebase, published at a
// version past the fix, with an identical API.
import * as XLSX from "@e965/xlsx";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deriveOpeningBalance, toMoneyAmount } from "@/lib/money";
import { findPakistaniIbans } from "@/lib/tax/bank-statement-fields";
import {
  getTaxYearStatementRange,
  validateDateWithinTaxYear,
} from "@/lib/tax/tax-year-period";
import {
  DOCUMENT_EXTRACTION_LEASE_MS,
  isDocumentExtractionLeaseStale,
} from "@/lib/tax/document-extraction-state";

const STRUCTURED_EXTENSIONS = new Set([".csv", ".xls", ".xlsx"]);

type RawCell = string | number | boolean | Date | null | undefined;

type ParsedTransaction = {
  date: string;
  description: string;
  debit: number | null;
  credit: number | null;
  balance: number | null;
};

function normalizeHeader(value: RawCell) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findColumn(headers: RawCell[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeHeader);
  const exactIndex = headers.findIndex((header) =>
    normalizedAliases.includes(normalizeHeader(header)),
  );
  if (exactIndex >= 0) return exactIndex;

  // Only use partial matching for descriptive aliases. Short aliases such as
  // "cr" or "dr" must not match words inside "Description".
  return headers.findIndex((header) => {
    const value = normalizeHeader(header);
    return normalizedAliases.some(
      (alias) => alias.length > 2 && value.includes(alias),
    );
  });
}

function parseAmount(value: RawCell) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function parseDate(value: RawCell) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()),
    );
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const rawYear = Number(slashDate[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const month = second > 12 ? first : first > 12 ? second : second;
    const day = second > 12 ? second : first > 12 ? first : first;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
      ? date
      : null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isBoundaryDescription(description: string) {
  const normalized = normalizeHeader(description);
  return (
    normalized.includes("opening balance") ||
    normalized.includes("closing balance") ||
    normalized.includes("balance brought forward") ||
    normalized.includes("balance carried forward")
  );
}

async function getOwnedDocument(documentId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) throw new Error("User profile not found");

  const document = await prisma.document.findFirst({
    where: { id: documentId, userId: user.id },
    include: { filingDraft: { select: { taxYear: true } } },
  });
  if (!document) throw new Error("Document not found");

  return document;
}

export async function extractStructuredBankDocumentAction(documentId: string) {
  let attemptDocumentId: string | null = null;
  let attemptUserId: string | null = null;
  let extractionAttemptStartedAt: Date | null = null;

  try {
    const document = await getOwnedDocument(documentId);
    attemptDocumentId = document.id;
    attemptUserId = document.userId;
    const extension = path.extname(document.fileName).toLowerCase();

    if (!STRUCTURED_EXTENSIONS.has(extension)) {
      return {
        success: false,
        error: "Structured parser supports CSV, XLS, and XLSX files only",
      };
    }

    if (document.documentType !== "bank_statement") {
      return {
        success: false,
        error: `CSV/XLS/XLSX files are only allowed for Bank Statement slot. You tried to upload a CSV as '${document.documentType}'. CNIC and Salary Certificate must be PDF/JPG/PNG. Please upload the correct file type for this slot.`,
      };
    }

    if (document.extractionStatus === "MAPPED") {
      return {
        success: false,
        code: "ALREADY_MAPPED",
        status: "MAPPED",
        error:
          "This document is already mapped. Replace it to extract a different file.",
      };
    }
    if (document.extractionStatus === "COMPLETED" && document.extractedData) {
      return {
        success: false,
        code: "ALREADY_EXTRACTED",
        status: "COMPLETED",
        error:
          "This document already has saved extraction data. Open Review & map, or replace the file to extract again.",
      };
    }
    if (
      document.extractionStatus === "PROCESSING" &&
      !isDocumentExtractionLeaseStale(
        document.extractionStatus,
        document.extractionStartedAt,
      )
    ) {
      return {
        success: false,
        code: "ALREADY_PROCESSING",
        status: "PROCESSING",
        extractionStartedAt: document.extractionStartedAt
          ? String(document.extractionStartedAt)
          : null,
        error:
          "This document is still being processed. The result will appear here automatically.",
      };
    }

    const attemptStartedAt = new Date();
    const staleBefore = new Date(
      attemptStartedAt.getTime() - DOCUMENT_EXTRACTION_LEASE_MS,
    );
    const claim = await prisma.document.updateMany({
      where: {
        id: document.id,
        userId: document.userId,
        OR: [
          { extractionStatus: { in: ["PENDING", "FAILED"] } },
          { extractionStatus: "COMPLETED", extractedData: null },
          { extractionStatus: "PROCESSING", extractionStartedAt: null },
          {
            extractionStatus: "PROCESSING",
            extractionStartedAt: { lte: staleBefore },
          },
        ],
      },
      data: {
        extractionStatus: "PROCESSING",
        extractionStartedAt: attemptStartedAt,
        extractionProvider: "structured-parser",
        extractionError: null,
      },
    });
    if (claim.count === 0) {
      const latest = await getOwnedDocument(document.id);
      if (
        latest.extractionStatus === "PROCESSING" &&
        !isDocumentExtractionLeaseStale(
          latest.extractionStatus,
          latest.extractionStartedAt,
        )
      ) {
        return {
          success: false,
          code: "ALREADY_PROCESSING",
          status: "PROCESSING",
          extractionStartedAt: latest.extractionStartedAt
            ? String(latest.extractionStartedAt)
            : null,
          error:
            "This document is still being processed. The result will appear here automatically.",
        };
      }
      if (latest.extractionStatus === "MAPPED") {
        return {
          success: false,
          code: "ALREADY_MAPPED",
          status: "MAPPED",
          error:
            "This document is already mapped. Replace it to extract a different file.",
        };
      }
      if (latest.extractionStatus === "COMPLETED" && latest.extractedData) {
        return {
          success: false,
          code: "ALREADY_EXTRACTED",
          status: "COMPLETED",
          error:
            "This document already has saved extraction data. Open Review & map, or replace the file to extract again.",
        };
      }
      return {
        success: false,
        error: "Could not start extraction. Please try again.",
      };
    }
    extractionAttemptStartedAt = attemptStartedAt;

    const updateThisAttempt = async (data: {
      extractionStatus: string;
      extractionProvider?: string;
      extractedData?: string;
      extractionError?: string | null;
      extractedAt?: Date | null;
    }) => {
      const updated = await prisma.document.updateMany({
        where: {
          id: document.id,
          userId: document.userId,
          extractionStatus: "PROCESSING",
          extractionStartedAt: attemptStartedAt,
        },
        data: { ...data, extractionStartedAt: null },
      });
      return updated.count === 1;
    };

    const filePath = path.join(
      process.cwd(),
      "uploads",
      path.basename(document.fileUrl),
    );
    const workbook = XLSX.read(await readFile(filePath), {
      type: "buffer",
      cellDates: true,
    });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("The spreadsheet has no sheets");

    const rows = XLSX.utils.sheet_to_json<RawCell[]>(
      workbook.Sheets[sheetName],
      {
        header: 1,
        defval: "",
        raw: true,
      },
    );
    if (rows.length < 2)
      throw new Error("The spreadsheet has no transaction rows");

    const headerIndex = rows.findIndex((row) => {
      const headers = row.map(normalizeHeader);
      return (
        headers.some((header) => header.includes("date")) &&
        headers.some((header) =>
          ["description", "narration", "particular", "details"].some((alias) =>
            header.includes(alias),
          ),
        )
      );
    });
    if (headerIndex < 0) {
      throw new Error(
        "Could not find Date and Description columns in the spreadsheet",
      );
    }

    const headers = rows[headerIndex];
    const dateColumn = findColumn(headers, [
      "date",
      "transaction date",
      "value date",
    ]);
    const descriptionColumn = findColumn(headers, [
      "description",
      "narration",
      "particulars",
      "transaction details",
      "details",
    ]);
    const debitColumn = findColumn(headers, ["debit", "withdrawal", "dr"]);
    const creditColumn = findColumn(headers, ["credit", "deposit", "cr"]);
    const balanceColumn = findColumn(headers, [
      "balance",
      "running balance",
      "closing balance",
    ]);
    const amountColumn = findColumn(headers, ["amount", "transaction amount"]);
    const typeColumn = findColumn(headers, ["transaction type", "type"]);

    if (dateColumn < 0 || descriptionColumn < 0) {
      throw new Error("Date and Description columns are required");
    }
    if (debitColumn < 0 && creditColumn < 0 && amountColumn < 0) {
      throw new Error("A Debit, Credit, or Amount column is required");
    }

    const taxYear = document.filingDraft?.taxYear;
    if (!taxYear) throw new Error("Filing Tax Year is not available");
    const range = getTaxYearStatementRange(taxYear);
    const transactions: ParsedTransaction[] = [];
    let openingBalance: number | null = null;
    let closingBalance: number | null = null;
    let openingBalanceDate: Date | null = null;
    let closingBalanceDate: Date | null = null;
    const dates: Date[] = [];

    for (const row of rows.slice(headerIndex + 1)) {
      const description = String(row[descriptionColumn] ?? "").trim();
      if (!description) continue;

      const date = parseDate(row[dateColumn]);
      if (!date)
        throw new Error(`Invalid transaction date for: ${description}`);

      const dateValidation = validateDateWithinTaxYear(taxYear, date);
      if (!dateValidation.valid) throw new Error(dateValidation.error);

      const balance =
        balanceColumn >= 0 ? parseAmount(row[balanceColumn]) : null;
      if (isBoundaryDescription(description)) {
        const normalizedBoundary = normalizeHeader(description);
        if (normalizedBoundary.includes("opening")) {
          openingBalance = balance;
          openingBalanceDate = date;
        }
        if (normalizedBoundary.includes("closing")) {
          closingBalance = balance;
          closingBalanceDate = date;
        }
        continue;
      }

      let debit = debitColumn >= 0 ? parseAmount(row[debitColumn]) : null;
      let credit = creditColumn >= 0 ? parseAmount(row[creditColumn]) : null;

      if (debit === null && credit === null && amountColumn >= 0) {
        const amount = parseAmount(row[amountColumn]);
        const type = typeColumn >= 0 ? normalizeHeader(row[typeColumn]) : "";
        if (amount !== null) {
          if (
            amount < 0 ||
            type.includes("debit") ||
            type.includes("withdraw")
          ) {
            debit = Math.abs(amount);
          } else {
            credit = amount;
          }
        }
      }

      if (debit === null && credit === null) continue;
      if (debit !== null && debit < 0) debit = Math.abs(debit);
      if (credit !== null && credit < 0) credit = Math.abs(credit);

      dates.push(date);
      transactions.push({
        date: date.toISOString().slice(0, 10),
        description,
        debit,
        credit,
        balance,
      });
    }

    if (transactions.length === 0) {
      throw new Error("No transaction rows were found in the spreadsheet");
    }

    dates.sort((a, b) => a.getTime() - b.getTime());
    const first = transactions[0];
    const last = transactions[transactions.length - 1];
    const statementStartDate = openingBalanceDate ?? dates[0];
    const statementEndDate = closingBalanceDate ?? dates[dates.length - 1];
    if (openingBalance === null && first.balance !== null) {
      openingBalance = deriveOpeningBalance(
        first.balance,
        first.credit,
        first.debit,
      );
    }
    if (closingBalance === null) {
      closingBalance =
        last.balance === null ? null : toMoneyAmount(last.balance);
    }

    // Exports often print the IBAN in a header row above the table. Use it
    // only when exactly one valid IBAN appears; otherwise the review form shows
    // a blank required IBAN field for the user to fill in.
    const ibansInSheet = findPakistaniIbans(
      rows
        .slice(0, Math.max(headerIndex, 0))
        .map((row) => row.map((cell) => String(cell ?? "")).join(" "))
        .join(" "),
    );
    const fields = [
      { label: "Currency", value: "PKR", confidence: 1 },
      ...(ibansInSheet.length === 1
        ? [{ label: "IBAN", value: ibansInSheet[0], confidence: 1 }]
        : []),
      {
        label: "From Date",
        value: statementStartDate.toISOString().slice(0, 10),
        confidence: openingBalanceDate ? 1 : 0.8,
      },
      {
        label: "To Date",
        value: statementEndDate.toISOString().slice(0, 10),
        confidence: closingBalanceDate ? 1 : 0.8,
      },
      {
        label: "Opening Balance",
        value: openingBalance,
        confidence: openingBalance === null ? 0.5 : 1,
      },
      {
        label: "Closing Balance",
        value: closingBalance,
        confidence: closingBalance === null ? 0.5 : 1,
      },
    ];

    const extracted = {
      documentType: "bank_statement",
      fields,
      transactions,
      notes: [
        `Structured parser imported ${transactions.length} transaction row(s) from ${extension.toUpperCase()}.`,
        ...(openingBalance === null || closingBalance === null
          ? [
              "Opening or closing balance was not found; review the fields before mapping.",
            ]
          : []),
      ],
    };

    const saved = await updateThisAttempt({
      extractionStatus: "COMPLETED",
      extractionProvider: "structured-parser",
      extractedData: JSON.stringify(extracted),
      extractionError: null,
      extractedAt: new Date(),
    });
    if (!saved) {
      return {
        success: false,
        code: "EXTRACTION_ATTEMPT_EXPIRED",
        error:
          "A newer extraction attempt has taken over. Refresh to see its result.",
      };
    }

    return {
      success: true,
      documentId: document.id,
      provider: "structured-parser",
      extracted,
    };
  } catch (error) {
    console.error("Error parsing structured bank document:", error);
    const message =
      error instanceof Error ? error.message : "Structured bank parsing failed";
    if (attemptDocumentId && attemptUserId && extractionAttemptStartedAt) {
      await prisma.document.updateMany({
        where: {
          id: attemptDocumentId,
          userId: attemptUserId,
          extractionStatus: "PROCESSING",
          extractionStartedAt: extractionAttemptStartedAt,
        },
        data: {
          extractionStatus: "FAILED",
          extractionStartedAt: null,
          extractionProvider: "structured-parser",
          extractionError: message,
        },
      });
    }
    return { success: false, error: message };
  }
}
