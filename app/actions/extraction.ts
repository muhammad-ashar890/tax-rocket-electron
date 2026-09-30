"use server";

import { readFile } from "fs/promises";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import { authOptions } from "@/lib/auth";
import { extractStructuredBankDocumentAction } from "@/app/actions/bank-parser";
import { createNotification } from "@/app/actions/notifications";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { parseTaxpayerDateOfBirth } from "@/lib/tax/taxpayer-age";
import {
  CARRY_FORWARD_DOCUMENT_TYPES,
  formatCnicInput,
  formatCnicNumber,
  normalizeIdentityName,
  planCnicProfileUpdate,
  planIdentityCarryForward,
  readCnicValidity,
} from "@/lib/tax/cnic-profile";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";
import {
  DOCUMENT_EXTRACTION_LEASE_MS,
  isDocumentExtractionLeaseStale,
} from "@/lib/tax/document-extraction-state";
import {
  ensureSalaryCertificateReviewFields,
  parseSalaryCertificateAmount,
  salaryCertificateFieldValue,
} from "@/lib/tax/salary-certificate-fields";

const GEMINI_SUPPORTED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const EXTRACTION_PROMPT = `You are extracting structured data from a Pakistani tax document.
Return only valid JSON. Do not include markdown fences or commentary.
Use this exact shape:
{
  "documentType": "string",
  "fields": [
    {
      "label": "string",
      "value": "string or number or null",
      "confidence": "number between 0 and 1"
    }
  ],
  "transactions": [
    {
      "date": "string or null",
      "description": "string",
      "debit": "number or null",
      "credit": "number or null",
      "balance": "number or null",
      "confidence": "number between 0 and 1"
    }
  ],
  "notes": ["string"]
}
For a bank statement, always return separate fields labelled exactly "Bank Name", "Account Label", "Account Number", "Currency", "Opening Balance", "Closing Balance", "Statement Period Start", and "Statement Period End". Never combine the statement dates into one field: read the start and end dates from the statement header and return each as ISO YYYY-MM-DD. Extract every visible transaction row from the statement table. Do not include opening-balance or closing-balance marker rows as transactions; those balances belong in fields. Do not invent rows. Return transaction dates as ISO YYYY-MM-DD whenever possible. Keep descriptions and currency amounts exactly as shown in the document.
For a CNIC, always return separate fields labelled exactly "CNIC Number", "Name", "Father Name", "Date of Birth" and "Expiry Date", plus "Address" when the card prints one. Return "Date of Birth" and "Expiry Date" as ISO YYYY-MM-DD. Read the date of birth from the "Date of Birth" line only: never use the issue date or the expiry date for it, and never guess a date of birth that is not printed on the card. For "Expiry Date" return the card's own validity/expiry line ("Valid Upto", "Expiry", "Date of Expiry"), or null when the card prints none — never infer one from the issue date.
For a salary certificate, always return separate required fields labelled exactly "Gross Salary (Annual PKR)" and "Tax Deducted u/s 149 (Annual PKR)". Use annual amounts explicitly stated on the certificate. If a value is not stated or cannot be read, return null; never infer gross salary from net bank deposits and never assume missing tax withheld is zero. Also preserve other tax-relevant details as separate optional fields when printed, including employer name/NTN, employee name/ID, tax year or salary period, basic pay, allowances, bonuses, benefits/perquisites, exempt or taxable components, and net pay. Do not invent missing details, combine separate components, or annualize monthly amounts unless the certificate explicitly states the annual total.`;

type DocumentSlotRule = {
  label: string;
  aliases: string[];
  fieldSignals: string[];
  minimumSignals: number;
};

const DOCUMENT_SLOT_RULES: Record<string, DocumentSlotRule> = {
  cnic: {
    label: "CNIC copy",
    aliases: ["cnic", "identity card", "national identity card"],
    fieldSignals: ["cnic", "identity number", "father name", "date of birth"],
    minimumSignals: 2,
  },
  bank_statement: {
    label: "bank statement",
    aliases: ["bank statement", "account statement"],
    fieldSignals: [
      "bank name",
      "account title",
      "account number",
      "iban",
      "opening balance",
      "closing balance",
      "transaction",
    ],
    minimumSignals: 2,
  },
  salary_certificate: {
    label: "salary certificate",
    aliases: ["salary certificate", "salary slip", "pay slip", "payslip"],
    fieldSignals: ["salary", "gross salary", "tax deducted", "employer"],
    minimumSignals: 2,
  },
  bank_certificate: {
    label: "bank profit certificate",
    aliases: [
      "bank profit certificate",
      "profit certificate",
      "profit statement",
    ],
    fieldSignals: ["bank profit", "profit", "profit rate", "tax deducted"],
    minimumSignals: 2,
  },
  pension_statement: {
    label: "pension statement",
    aliases: ["pension statement", "pension certificate"],
    fieldSignals: ["pension", "pensioner", "monthly pension"],
    minimumSignals: 1,
  },
  rent_agreement: {
    label: "rent agreement or receipts",
    aliases: ["rent agreement", "rental receipt", "lease agreement"],
    fieldSignals: ["rent", "landlord", "tenant", "property"],
    minimumSignals: 2,
  },
  invoice_summary: {
    label: "invoices or service income summary",
    aliases: ["invoice", "service income summary", "freelance invoice"],
    fieldSignals: ["invoice", "client", "service", "quantity"],
    minimumSignals: 2,
  },
  dividend_certificate: {
    label: "dividend certificate",
    aliases: ["dividend certificate", "dividend statement"],
    fieldSignals: ["dividend", "shares", "withholding"],
    minimumSignals: 2,
  },
  cgt_statement: {
    label: "capital gains statement",
    aliases: ["capital gains statement", "cgt statement"],
    fieldSignals: ["capital gain", "sale price", "purchase price", "shares"],
    minimumSignals: 2,
  },
  business_books: {
    label: "business books or sales records",
    aliases: ["business books", "sales records", "business record"],
    fieldSignals: ["sales", "revenue", "expense", "profit"],
    minimumSignals: 2,
  },
  agri_record: {
    label: "agriculture income record",
    aliases: ["agriculture record", "farm income record", "agri record"],
    fieldSignals: ["agriculture", "crop", "farm", "land"],
    minimumSignals: 2,
  },
  foreign_asset_statement: {
    label: "foreign asset or income statement",
    aliases: [
      "foreign asset statement",
      "foreign income statement",
      "overseas asset",
    ],
    fieldSignals: ["foreign", "overseas", "country", "asset"],
    minimumSignals: 2,
  },
  aop_company_proof: {
    label: "AOP or company proof",
    aliases: ["aop proof", "company proof", "partnership proof"],
    fieldSignals: ["aop", "partnership", "company", "shareholding"],
    minimumSignals: 2,
  },
  sales_tax_return: {
    label: "sales tax or FED return",
    aliases: ["sales tax return", "fed return", "gst return"],
    fieldSignals: ["sales tax", "fed", "gst", "output tax"],
    minimumSignals: 2,
  },
  other_income_proof: {
    label: "other income proof",
    aliases: ["other income proof", "income receipt", "income proof"],
    fieldSignals: ["income", "receipt", "payer", "amount"],
    minimumSignals: 2,
  },
};

function normalizeDocumentText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildExtractionPrompt(documentType: string) {
  const rule = DOCUMENT_SLOT_RULES[documentType];
  if (!rule) return EXTRACTION_PROMPT;

  return `${EXTRACTION_PROMPT}

Expected upload slot: ${rule.label}.
Verify the actual document content against this slot. Do not label a bank statement as a CNIC, or a CNIC as a bank statement. If the uploaded document does not match the expected slot, still return its actual documentType so the application can reject it.`;
}

function validateExtractedDocument(documentType: string, extracted: unknown) {
  const rule = DOCUMENT_SLOT_RULES[documentType];
  if (!rule) return { valid: true as const };

  const payload = extracted as {
    documentType?: unknown;
    fields?: Array<{ label?: unknown }>;
    transactions?: unknown[];
  };
  const declaredType = normalizeDocumentText(payload.documentType);
  const fieldLabels = (payload.fields ?? [])
    .map((field) => normalizeDocumentText(field.label))
    .join(" ");
  const hasTransactions =
    Array.isArray(payload.transactions) && payload.transactions.length > 0;

  const declaredTypeMatches = rule.aliases.some((alias) =>
    declaredType.includes(normalizeDocumentText(alias)),
  );

  // Count how many expected signals are present in extracted field labels
  const matchingSignals = rule.fieldSignals.filter((signal) =>
    fieldLabels.includes(normalizeDocumentText(signal)),
  ).length;

  // Strict check: field signals must meet minimum, regardless of declared type
  // This prevents uploading a dashboard screenshot as CNIC, etc.
  if (matchingSignals < rule.minimumSignals) {
    // Special case: bank_statement can be validated via transactions presence
    if (documentType === "bank_statement" && hasTransactions) {
      // If we have transactions, allow even if few field signals, as long as declared type matches or signals >=1
      if (declaredTypeMatches || matchingSignals >= 1) {
        return { valid: true as const };
      }
    }

    // If declared type is clearly wrong (e.g., user uploaded bank statement into CNIC slot),
    // we fail even if some signals accidentally match
    const clearlyWrongType =
      declaredType && !declaredTypeMatches && matchingSignals === 0;
    if (clearlyWrongType) {
      return {
        valid: false as const,
        error: `This file looks like a ${String(payload.documentType || "different document")}, not a ${rule.label}. Please upload the correct ${rule.label} for this slot.`,
      };
    }

    return {
      valid: false as const,
      error: `This file does not appear to be a ${rule.label}. Found only ${matchingSignals}/${rule.minimumSignals} expected fields (${rule.fieldSignals.join(", ")}). Upload the correct document for this slot.`,
    };
  }

  // If signals are enough, we pass, but if declared type is explicitly different document, warn
  // e.g., declared as "bank_statement" when expecting "cnic" — still fail if signals just barely meet minimum
  if (!declaredTypeMatches && declaredType) {
    // Check if declared type belongs to another known slot
    const otherSlot = Object.entries(DOCUMENT_SLOT_RULES).find(
      ([key, otherRule]) =>
        key !== documentType &&
        otherRule.aliases.some((a) =>
          declaredType.includes(normalizeDocumentText(a)),
        ),
    );
    if (otherSlot && matchingSignals < rule.minimumSignals + 1) {
      return {
        valid: false as const,
        error: `This file appears to be a ${otherSlot[1].label}, not a ${rule.label}. Upload the correct ${rule.label}.`,
      };
    }
  }

  return { valid: true as const };
}

async function getCurrentUserId() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) throw new Error("User profile not found");
  return user.id;
}

async function getOwnedDraft(draftId: string) {
  const userId = await getCurrentUserId();
  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId },
    select: { id: true, userId: true },
  });
  if (!draft) throw new Error("Filing draft not found");
  return draft;
}

async function getOwnedDocument(documentId: string) {
  const userId = await getCurrentUserId();
  const document = await prisma.document.findFirst({
    where: { id: documentId, userId },
  });
  if (!document) throw new Error("Document not found");
  return document;
}

function parseModelJson(text: string) {
  const withoutFence = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new TypeError("Gemini did not return valid JSON");
    }
    return JSON.parse(withoutFence.slice(start, end + 1));
  }
}

/**
 * Identity documents (currently the CNIC) belong to the person, not to a tax year,
 * so a card approved for one filing must not have to be uploaded again for the
 * next one. This copies the already-approved record onto the new draft — the draft
 * keeps its own audit row (packets and evidence refer to a document per filing),
 * while the human does the upload exactly once.
 *
 * It never invents verification: the copy only happens when the profile still
 * carries the CNIC and date of birth that the earlier approval wrote.
 */
/**
 * Read one field back out of a stored extraction payload. Defensive by design: a
 * payload saved by an older version of the extractor simply yields no value, which
 * means "could not check", never "expired".
 */
function extractFieldFromPayload(
  payload: string | null | undefined,
  labels: string[],
): unknown {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as {
      fields?: Array<{ label: string; value: unknown }>;
    };
    return exactFieldValue(parsed?.fields ?? [], labels);
  } catch {
    return null;
  }
}

export async function carryForwardIdentityDocumentsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const results = [] as {
      documentType: string;
      copied: boolean;
      reason: string;
      sourceTaxYear?: number | null;
      sourceExpiry?: string | null;
    }[];

    for (const documentType of CARRY_FORWARD_DOCUMENT_TYPES) {
      const present = await prisma.document.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType,
          extractionStatus: "MAPPED",
        },
        select: { id: true },
      });
      const profile = await prisma.user.findUnique({
        where: { id: draft.userId },
        select: { cnic: true, dateOfBirth: true },
      });
      // Only a card that an operator already approved counts as a source; a file
      // that was uploaded and left unreviewed proves nothing.
      const prior = await prisma.document.findFirst({
        where: {
          userId: draft.userId,
          documentType,
          extractionStatus: "MAPPED",
          filingDraftId: { not: draft.id },
        },
        orderBy: { extractedAt: "desc" },
        include: { filingDraft: { select: { taxYear: true } } },
      });

      // The card is only reusable while it is still valid: one approved in a
      // previous year may have lapsed since, and reusing a lapsed card would carry
      // an invalid identity into a new return.
      const priorValidity = readCnicValidity({
        expiryDate: extractFieldFromPayload(prior?.extractedData, [
          "expiry_date",
          "expiry",
          "valid_upto",
          "valid_until",
          "date_of_expiry",
        ]),
      });

      const plan = planIdentityCarryForward({
        documentType,
        draftAlreadyHasIt: Boolean(present),
        profileVerified: Boolean(profile?.cnic && profile?.dateOfBirth),
        hasPriorUpload: Boolean(prior),
        priorTaxYear: prior?.filingDraft?.taxYear ?? null,
        priorExpired: priorValidity.status === "expired",
        priorExpiry: priorValidity.expiry,
      });

      if (!plan.copy) {
        results.push({
          documentType,
          copied: false,
          reason: plan.reason,
          sourceExpiry: plan.sourceExpiry ?? null,
        });
        continue;
      }

      await prisma.document.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType,
          fileName: prior.fileName,
          fileUrl: prior.fileUrl,
          mimeType: prior.mimeType,
          sizeBytes: prior.sizeBytes,
          extractionStatus: "MAPPED",
          extractionProvider: prior.extractionProvider,
          extractedData: prior.extractedData,
          extractedAt: prior.extractedAt,
        },
      });

      results.push({
        documentType,
        copied: true,
        reason: plan.reason,
        sourceTaxYear: plan.sourceTaxYear,
        sourceExpiry: priorValidity.expiry,
      });
    }

    revalidatePath("/tax/new");
    return { success: true, results };
  } catch (error) {
    console.error("Error carrying forward identity documents:", error);
    // Reuse is an optimisation: on any failure the ordinary upload path still works,
    // so this must never block the documents step.
    return { success: false, error: "carry_forward_failed", results: [] };
  }
}

export async function getFilingDocumentsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const documents = await prisma.document.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        documentType: true,
        fileName: true,
        extractionStatus: true,
        extractionProvider: true,
        extractionStartedAt: true,
        extractionError: true,
        extractedAt: true,
        bankAccountId: true,
      },
    });

    return {
      success: true,
      documents: documents.map((document) => ({
        ...document,
        documentType: document.bankAccountId
          ? `bank_statement:${document.bankAccountId}`
          : document.documentType,
        extractionStartedAt: document.extractionStartedAt
          ? String(document.extractionStartedAt)
          : null,
        extractedAt: document.extractedAt ? String(document.extractedAt) : null,
      })),
    };
  } catch (error) {
    console.error("Error fetching filing documents:", error);
    return { success: false, error: "Failed to fetch filing documents" };
  }
}

export async function getDocumentExtractionAction(documentId: string) {
  try {
    const document = await getOwnedDocument(documentId);
    const extracted = document.extractedData
      ? JSON.parse(document.extractedData)
      : null;
    const reviewReadyExtraction =
      document.documentType === "salary_certificate"
        ? ensureSalaryCertificateReviewFields(extracted)
        : extracted;

    return {
      success: true,
      extraction: reviewReadyExtraction,
      status: document.extractionStatus,
      extractionStartedAt: document.extractionStartedAt
        ? String(document.extractionStartedAt)
        : null,
      extractionError: document.extractionError,
    };
  } catch (error) {
    console.error("Error fetching document extraction:", error);
    return { success: false, error: "Failed to fetch extracted data" };
  }
}

export async function updateDocumentExtractionAction(
  documentId: string,
  extracted: unknown,
) {
  try {
    const document = await getOwnedDocument(documentId);
    const reviewReadyExtraction =
      document.documentType === "salary_certificate"
        ? ensureSalaryCertificateReviewFields(extracted)
        : extracted;
    const normalized = normalizeIdentityExtractionPayload(
      document.documentType,
      reviewReadyExtraction,
    );
    if (normalized.error) {
      return { success: false, error: normalized.error };
    }

    await prisma.document.update({
      where: { id: documentId },
      data: {
        extractedData: JSON.stringify(normalized.payload),
        extractionStatus: "COMPLETED",
        extractionStartedAt: null,
        extractionError: null,
        extractedAt: new Date(),
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Error updating document extraction:", error);
    return { success: false, error: "Failed to save extracted data" };
  }
}

function normalizedLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fieldValue(
  fields: Array<{ label: string; value: unknown }>,
  labels: string[],
) {
  const wanted = labels.map(normalizedLabel);
  return fields.find((field) => {
    const actual = normalizedLabel(field.label);
    return wanted.some((label) => actual === label || actual.includes(label));
  })?.value;
}

/**
 * `fieldValue` matches on substrings, which is right for synonyms but wrong for
 * identity fields: "father name" CONTAINS "name", so the requested father's name
 * could be stored as the taxpayer's own legal name if the extraction listed them
 * in the other order. Labels the prompt pins exactly are compared exactly.
 */
function exactFieldValue(
  fields: Array<{ label: string; value: unknown }>,
  labels: string[],
) {
  const wanted = labels.map(normalizedLabel);
  return fields.find((field) => wanted.includes(normalizedLabel(field.label)))
    ?.value;
}

function parseExtractedAmount(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIdentityExtractionPayload(
  documentType: string,
  extracted: unknown,
): { payload: unknown; error?: string } {
  if (documentType !== "cnic" || !extracted || typeof extracted !== "object") {
    return { payload: extracted };
  }

  const payload = extracted as {
    fields?: Array<{
      label?: unknown;
      value?: unknown;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  if (!Array.isArray(payload.fields)) return { payload: extracted };

  const fields = payload.fields.map((field) => {
    const label = normalizedLabel(String(field.label ?? ""));
    const value = field.value;

    if (["cnic_number", "cnic", "identity_number"].includes(label)) {
      const raw = String(value ?? "");
      const digitCount = (raw.match(/[0-9]/g) ?? []).length;
      if (digitCount > 13) {
        return {
          ...field,
          value,
          __validationError:
            "The CNIC number has more than 13 digits. Remove the extra digits and try again.",
        };
      }
      return { ...field, value: formatCnicInput(raw) };
    }

    if (["name", "full_name", "taxpayer_name"].includes(label)) {
      return { ...field, value: normalizeIdentityName(value) };
    }

    if (
      [
        "date_of_birth",
        "dob",
        "birth_date",
        "expiry_date",
        "expiry",
        "valid_upto",
        "valid_until",
        "date_of_expiry",
      ].includes(label)
    ) {
      const parsed = parseTaxpayerDateOfBirth(value);
      if (String(value ?? "").trim() && !parsed) {
        return {
          ...field,
          value,
          __validationError: `The ${String(field.label ?? "identity date")} must be a valid date in YYYY-MM-DD format.`,
        };
      }
      return {
        ...field,
        value: parsed ? parsed.toISOString().slice(0, 10) : "",
      };
    }

    return field;
  });

  const validationError = fields.find(
    (field) => typeof field.__validationError === "string",
  )?.__validationError;
  if (typeof validationError === "string") {
    return { payload: extracted, error: validationError };
  }

  return { payload: { ...payload, fields } };
}

function parseExtractedDate(value: unknown) {
  if (!value) return null;

  const text = String(value).trim();
  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);

  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const rawYear = Number(slashDate[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;

    // Pakistani statements commonly use DD/MM/YY. If one side is
    // greater than 12, use the only unambiguous interpretation.
    const month = second > 12 ? first : first > 12 ? second : second;
    const day = second > 12 ? second : first > 12 ? first : first;
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date;
    }

    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTransactionDateRange(transactions: Array<{ date?: unknown }>) {
  const dates = transactions
    .map((transaction) => parseExtractedDate(transaction.date))
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    start: dates[0] ?? null,
    end: dates[dates.length - 1] ?? null,
  };
}

function isStatementBoundaryRow(description: string) {
  const normalized = description
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

  return (
    normalized.includes("opening balance") ||
    normalized.includes("closing balance") ||
    normalized.includes("balance brought forward") ||
    normalized.includes("balance carried forward")
  );
}

function normalizeExtractedPayload(extracted: unknown) {
  if (!extracted || typeof extracted !== "object") return extracted;

  const payload = extracted as {
    transactions?: Array<{
      date?: unknown;
      description?: unknown;
      debit?: unknown;
      credit?: unknown;
      balance?: unknown;
      confidence?: unknown;
    }>;
  };

  if (!Array.isArray(payload.transactions)) return extracted;

  return {
    ...payload,
    transactions: payload.transactions.flatMap((transaction) => {
      const description = String(transaction.description ?? "").trim();
      if (!description || isStatementBoundaryRow(description)) return [];

      const parsedDate = parseExtractedDate(transaction.date);
      return [
        {
          ...transaction,
          date: parsedDate ? parsedDate.toISOString().slice(0, 10) : null,
        },
      ];
    }),
  };
}

function parseExtractedTransactions(
  transactions: Array<{
    date?: unknown;
    description?: unknown;
    debit?: unknown;
    credit?: unknown;
    balance?: unknown;
  }>,
  document: {
    id: string;
    filingDraftId: string;
    userId: string;
    bankStatementId: string;
    bankAccountId: string | null;
  },
) {
  return transactions.flatMap((transaction) => {
    const description = String(transaction.description ?? "").trim();
    if (isStatementBoundaryRow(description)) return [];

    const debit = parseExtractedAmount(transaction.debit);
    const credit = parseExtractedAmount(transaction.credit);
    const balance = parseExtractedAmount(transaction.balance);

    if (!description || (debit === null && credit === null)) return [];

    return [
      {
        filingDraftId: document.filingDraftId,
        bankStatementId: document.bankStatementId,
        bankAccountId: document.bankAccountId,
        userId: document.userId,
        transactionDate: parseExtractedDate(transaction.date),
        description,
        debit,
        credit,
        balance,
        source: "DOCUMENT_EXTRACTION",
        sourceDocumentId: document.id,
      },
    ];
  });
}

export async function approveAndMapExtractedDocumentAction(documentId: string) {
  try {
    const document = await getOwnedDocument(documentId);
    if (!document.filingDraftId) {
      return { success: false, error: "Document is not attached to a filing" };
    }

    const extracted = document.extractedData
      ? (JSON.parse(document.extractedData) as {
          fields?: Array<{ label: string; value: unknown }>;
          transactions?: Array<{
            date?: unknown;
            description?: unknown;
            debit?: unknown;
            credit?: unknown;
            balance?: unknown;
          }>;
        })
      : null;
    const fields = extracted?.fields ?? [];

    if (document.documentType === "bank_statement") {
      if (!document.bankAccountId) {
        return {
          success: false,
          error:
            "This bank statement is not linked to a selected bank account. Replace it from an account-specific upload slot.",
        };
      }

      const openingBalance = parseExtractedAmount(
        fieldValue(fields, ["opening_balance", "balance_at_1_february"]),
      );
      const closingBalance = parseExtractedAmount(
        fieldValue(fields, ["closing_balance", "balance_at_1_march"]),
      );

      if (openingBalance === null || closingBalance === null) {
        return {
          success: false,
          error:
            "Opening and closing balances were not found in extracted data",
        };
      }

      const draft = await prisma.filingDraft.findUnique({
        where: { id: document.filingDraftId },
        select: { taxYear: true },
      });

      if (!draft) {
        return { success: false, error: "Filing draft not found" };
      }

      const userId = document.userId;
      const bankAccount = await prisma.bankAccount.findFirst({
        where: {
          id: document.bankAccountId,
          filingDraftId: document.filingDraftId,
          userId,
        },
        select: {
          id: true,
          bankName: true,
          accountLabel: true,
          accountNumberMasked: true,
          currency: true,
        },
      });
      if (!bankAccount) {
        return {
          success: false,
          error: "The bank account linked to this statement is no longer valid",
        };
      }

      const extractedBankName = String(
        fieldValue(fields, ["bank_name", "bank"]) ?? "",
      )
        .toLowerCase()
        .replace(/\bbank\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const expectedBankName = bankAccount.bankName
        .toLowerCase()
        .replace(/\bbank\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

      if (
        extractedBankName &&
        expectedBankName &&
        !extractedBankName.includes(expectedBankName) &&
        !expectedBankName.includes(extractedBankName)
      ) {
        return {
          success: false,
          error: `This statement appears to be for ${String(fieldValue(fields, ["bank_name", "bank"]))}, but it was uploaded under ${bankAccount.bankName} — ${bankAccount.accountLabel}. Replace it with the correct statement.`,
        };
      }

      const accountLabel = bankAccount.accountLabel;
      const existingStatement = await prisma.bankStatement.findFirst({
        where: {
          filingDraftId: document.filingDraftId,
          userId,
          bankAccountId: bankAccount.id,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, periodStart: true, periodEnd: true },
      });
      const transactionDateRange = getTransactionDateRange(
        extracted?.transactions ?? [],
      );
      const periodStart =
        parseExtractedDate(
          fieldValue(fields, ["from_date", "statement_period_start"]),
        ) ??
        existingStatement?.periodStart ??
        transactionDateRange.start;
      const periodEnd =
        parseExtractedDate(
          fieldValue(fields, ["to_date", "statement_period_end"]),
        ) ??
        existingStatement?.periodEnd ??
        transactionDateRange.end;
      const currency = bankAccount.currency.trim().toUpperCase();
      const periodValidation = validateTaxYearStatement({
        taxYear: draft.taxYear,
        periodStart,
        periodEnd,
        currency,
      });

      if (!periodValidation.valid) {
        return { success: false, error: periodValidation.error };
      }

      const existing = await prisma.bankStatement.findFirst({
        where: {
          filingDraftId: document.filingDraftId,
          userId,
          bankAccountId: bankAccount.id,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      const data = {
        accountLabel,
        accountNumberMasked: bankAccount.accountNumberMasked,
        currency,
        periodStart,
        periodEnd,
        openingBalance,
        closingBalance,
        sourceDocumentId: document.id,
        bankAccountId: bankAccount.id,
      };

      const statement = existing
        ? await prisma.bankStatement.update({
            where: { id: existing.id },
            data,
          })
        : await prisma.bankStatement.create({
            data: {
              ...data,
              filingDraftId: document.filingDraftId,
              userId,
            },
          });

      const extractedTransactions = parseExtractedTransactions(
        extracted?.transactions ?? [],
        {
          id: document.id,
          filingDraftId: document.filingDraftId,
          userId,
          bankStatementId: statement.id,
          bankAccountId: bankAccount.id,
        },
      );

      const previousExtractedTransactions =
        await prisma.bankTransaction.findMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId,
            OR: [
              {
                sourceDocumentId: document.id,
                bankAccountId: bankAccount.id,
              },
              {
                sourceDocumentId: document.id,
                bankAccountId: null,
              },
              {
                bankStatementId: statement.id,
                bankAccountId: bankAccount.id,
                source: "DOCUMENT_EXTRACTION",
              },
              {
                bankStatementId: statement.id,
                bankAccountId: null,
                source: "DOCUMENT_EXTRACTION",
              },
            ],
          },
          select: { id: true },
        });

      await prisma.$transaction(async (tx) => {
        if (previousExtractedTransactions.length > 0) {
          const previousIds = previousExtractedTransactions.map(
            (row) => row.id,
          );
          await tx.ledgerEntry.deleteMany({
            where: {
              filingDraftId: document.filingDraftId,
              userId,
              sourceTransactionId: { in: previousIds },
            },
          });
          await tx.bankTransaction.deleteMany({
            where: { id: { in: previousIds } },
          });
        }

        await tx.bankTransaction.updateMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId,
            bankAccountId: bankAccount.id,
            sourceDocumentId: document.id,
            bankStatementId: null,
          },
          data: {
            bankAccountId: bankAccount.id,
            bankStatementId: statement.id,
          },
        });

        if (extractedTransactions.length > 0) {
          await tx.bankTransaction.createMany({ data: extractedTransactions });
        }

        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
      });

      return {
        success: true,
        mapping: "BANK_STATEMENT",
        statementId: statement.id,
        transactionCount: extractedTransactions.length,
      };
    }

    if (document.documentType === "cnic") {
      // The CNIC is the authoritative source for date of birth, which the
      // Section 149(IA) pension rules need, and it carries the legal name and the
      // address too. What may be written where is decided by `planCnicProfileUpdate`
      // (pure, unit-tested); this branch only reads, applies and reports.
      const extractedDateOfBirth = parseTaxpayerDateOfBirth(
        fieldValue(fields, ["date_of_birth", "dob", "birth_date"]),
      );
      // Whole-label lookup again: "Date of Issue" must not satisfy "Expiry Date".
      const extractedExpiryDate = exactFieldValue(fields, [
        "expiry_date",
        "expiry",
        "valid_upto",
        "valid_until",
        "date_of_expiry",
      ]);

      const profile = await prisma.user.findUnique({
        where: { id: document.userId },
        select: { name: true, cnic: true, dateOfBirth: true, address: true },
      });
      const rawCardCnic = String(
        exactFieldValue(fields, ["cnic_number", "cnic", "identity_number"]) ??
          "",
      ).trim();
      const cardCnicDigits = rawCardCnic.replace(/[^0-9]/g, "");
      if (cardCnicDigits.length !== 13) {
        return {
          success: false,
          error:
            "The CNIC number must contain exactly 13 digits. Correct the extracted value before approving.",
        };
      }
      const formattedCardCnic = formatCnicNumber(cardCnicDigits);
      const cnicTakenByOtherAccount = Boolean(
        await prisma.user.findFirst({
          where: {
            id: { not: document.userId },
            cnic: { in: [cardCnicDigits, formattedCardCnic] },
          },
          select: { id: true },
        }),
      );

      const plan = planCnicProfileUpdate({
        profile: profile ?? {},
        extracted: {
          name: exactFieldValue(fields, ["name", "full_name", "taxpayer_name"]),
          cnic: cardCnicDigits,
          dateOfBirth: extractedDateOfBirth,
          address: exactFieldValue(fields, ["address"]),
          expiryDate: extractedExpiryDate,
        },
        cnicTakenByOtherAccount,
      });

      // A lapsed card is refused before any write, so it can never become the
      // identity of record for a filing.
      if (plan.expired) {
        return {
          success: false,
          error:
            plan.validity.message ??
            "This CNIC has expired, so it cannot be used. Upload the renewed card.",
        };
      }

      if (plan.missingDateOfBirth) {
        return {
          success: false,
          error:
            "Date of birth was not found on this CNIC. Re-run extraction or enter it manually in the taxpayer profile.",
        };
      }

      await prisma.$transaction(async (tx) => {
        if (Object.keys(plan.update).length > 0) {
          await tx.user.update({
            where: { id: document.userId },
            data: plan.update,
          });
        }

        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
      });

      revalidatePath("/tax/profile");
      revalidatePath("/tax/dashboard");

      return {
        success: true,
        mapping: "CNIC",
        dateOfBirth: extractedDateOfBirth!.toISOString().slice(0, 10),
        // Summary only: the raw profile row is never handed to the client.
        profilePlan: {
          filled: plan.filled,
          skipped: plan.skipped,
          overwritten: plan.overwritten,
          validity: plan.validity,
        },
      };
    }

    if (document.documentType === "salary_certificate") {
      const salaryFields = fields as Array<{ label: string; value: unknown }>;
      const grossSalary = parseSalaryCertificateAmount(
        salaryCertificateFieldValue(salaryFields, "gross_salary"),
      );
      const taxWithheld = parseSalaryCertificateAmount(
        salaryCertificateFieldValue(salaryFields, "tax_withheld"),
      );

      if (grossSalary === null || grossSalary <= 0) {
        return {
          success: false,
          error:
            "Enter the annual gross salary from the certificate before approving the map.",
        };
      }
      if (taxWithheld === null || taxWithheld < 0) {
        return {
          success: false,
          error:
            "Enter annual tax deducted u/s 149, or enter 0 after confirming that no salary tax was withheld.",
        };
      }

      // Do not create a second cash-ledger salary row from the certificate.
      // Bank deposits stay in the ledger for wealth reconciliation; the tax
      // calculator and IRIS salary row read gross pay from this mapped document.
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId: document.userId,
            sourceDocumentId: document.id,
          },
        });
        await tx.filingDraft.update({
          where: { id: document.filingDraftId },
          data: {
            taxWithheld,
            taxableIncome: null,
            taxPayable: null,
            refundDue: null,
            taxCalculationStatus: "NOT_CALCULATED",
            packetApprovalConfirmed: false,
            packetApprovalAt: null,
            packetApprovalByUserId: null,
            status: "IN_PROGRESS",
          },
        });
        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
        await tx.filingPacket.updateMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId: document.userId,
            status: { not: "SUPERSEDED" },
          },
          data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
        });
      });

      return { success: true, mapping: "SALARY", grossSalary, taxWithheld };
    }

    return {
      success: false,
      error: "No mapping rule exists for this document type yet",
    };
  } catch (error) {
    console.error("Error mapping extracted document:", error);
    return { success: false, error: "Failed to map extracted document" };
  }
}

export async function extractDocumentWithGeminiAction(documentId: string) {
  let documentIdForError: string | null = null;
  let userIdForError: string | null = null;
  let extractionAttemptStartedAt: Date | null = null;

  try {
    const document = await getOwnedDocument(documentId);
    documentIdForError = document.id;
    userIdForError = document.userId;

    const extension = path.extname(document.fileName).toLowerCase();
    if (extension === ".csv" || extension === ".xls" || extension === ".xlsx") {
      const parserResult =
        await extractStructuredBankDocumentAction(documentId);
      await createNotification({
        userId: document.userId,
        type: "DOCUMENT_PROCESSING",
        title: parserResult.success
          ? "Bank document processing completed"
          : "Bank document processing failed",
        message: parserResult.success
          ? `${document.fileName} was parsed and is ready for review.`
          : `${document.fileName}: ${parserResult.error ?? "Structured parsing failed"}`,
        link: document.filingDraftId
          ? `/tax/new?draftId=${document.filingDraftId}`
          : "/tax/new",
      });
      return parserResult;
    }

    if (!GEMINI_SUPPORTED_TYPES.has(document.mimeType)) {
      return {
        success: false,
        error:
          "Gemini extraction currently supports PDF, JPG, and PNG documents",
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

    const extractionLimit = consumeRateLimit(
      `gemini:${document.userId}`,
      10,
      10 * 60 * 1000,
    );
    if (!extractionLimit.allowed) {
      return {
        success: false,
        error: `Too many extraction requests. Try again in ${extractionLimit.retryAfterSeconds} seconds.`,
      };
    }

    // Claim pending/failed work, or take over a lease abandoned by a crashed
    // request. The conditional write keeps two tabs from starting Gemini twice.
    const attemptStartedAt = new Date();
    const staleBefore = new Date(
      attemptStartedAt.getTime() - DOCUMENT_EXTRACTION_LEASE_MS,
    );
    const processingClaim = await prisma.document.updateMany({
      where: {
        id: document.id,
        userId: document.userId,
        OR: [
          { extractionStatus: { in: ["PENDING", "FAILED"] } },
          {
            extractionStatus: "COMPLETED",
            extractedData: null,
          },
          {
            extractionStatus: "PROCESSING",
            extractionStartedAt: null,
          },
          {
            extractionStatus: "PROCESSING",
            extractionStartedAt: { lte: staleBefore },
          },
        ],
      },
      data: {
        extractionStatus: "PROCESSING",
        extractionStartedAt: attemptStartedAt,
        extractionProvider: "gemini",
        extractionError: null,
      },
    });

    if (processingClaim.count === 0) {
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
      const update = await prisma.document.updateMany({
        where: {
          id: document.id,
          userId: document.userId,
          extractionStatus: "PROCESSING",
          extractionStartedAt: attemptStartedAt,
        },
        data: {
          ...data,
          extractionStartedAt: null,
        },
      });
      return update.count === 1;
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const saved = await updateThisAttempt({
        extractionStatus: "FAILED",
        extractionProvider: "gemini",
        extractionError: "GEMINI_API_KEY is not configured",
      });
      if (saved) {
        await createNotification({
          userId: document.userId,
          type: "DOCUMENT_PROCESSING",
          title: "Document processing failed",
          message: `${document.fileName}: GEMINI_API_KEY is not configured.`,
          link: document.filingDraftId
            ? `/tax/new?draftId=${document.filingDraftId}`
            : "/tax/new",
        });
      }
      return {
        success: false,
        error: saved
          ? "GEMINI_API_KEY is not configured"
          : "A newer extraction attempt has taken over. Refresh to see its status.",
      };
    }

    const storedFileName = path.basename(document.fileUrl);
    const filePath = path.join(process.cwd(), "uploads", storedFileName);
    const fileBuffer = await readFile(filePath);
    const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
    });

    const result = await model.generateContent([
      { text: buildExtractionPrompt(document.documentType) },
      {
        inlineData: {
          data: fileBuffer.toString("base64"),
          mimeType: document.mimeType,
        },
      },
    ]);

    const normalizedExtraction = normalizeExtractedPayload(
      parseModelJson(result.response.text()),
    );
    const validation = validateExtractedDocument(
      document.documentType,
      normalizedExtraction,
    );
    const extracted =
      document.documentType === "salary_certificate"
        ? ensureSalaryCertificateReviewFields(normalizedExtraction)
        : normalizedExtraction;

    if (!validation.valid) {
      const saved = await updateThisAttempt({
        extractionStatus: "FAILED",
        extractionProvider: "gemini",
        extractedData: JSON.stringify(extracted),
        extractionError: validation.error,
        extractedAt: null,
      });
      if (saved) {
        await createNotification({
          userId: document.userId,
          type: "DOCUMENT_PROCESSING",
          title: "Document processing failed",
          message: `${document.fileName}: ${validation.error}`,
          link: document.filingDraftId
            ? `/tax/new?draftId=${document.filingDraftId}`
            : "/tax/new",
        });
      }
      return {
        success: false,
        code: saved ? undefined : "EXTRACTION_ATTEMPT_EXPIRED",
        error: saved
          ? validation.error
          : "A newer extraction attempt has taken over. Refresh to see its status.",
      };
    }

    const saved = await updateThisAttempt({
      extractionStatus: "COMPLETED",
      extractionProvider: "gemini",
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

    await createNotification({
      userId: document.userId,
      type: "DOCUMENT_PROCESSING",
      title: "Document processing completed",
      message: `${document.fileName} was extracted and is ready for review.`,
      link: document.filingDraftId
        ? `/tax/new?draftId=${document.filingDraftId}`
        : "/tax/new",
    });

    return {
      success: true,
      documentId: document.id,
      provider: "gemini",
      status: "COMPLETED",
      extracted,
    };
  } catch (error) {
    if (documentIdForError && userIdForError && extractionAttemptStartedAt) {
      const message =
        error instanceof Error ? error.message : "Unknown extraction error";
      const failedUpdate = await prisma.document.updateMany({
        where: {
          id: documentIdForError,
          userId: userIdForError,
          extractionStatus: "PROCESSING",
          extractionStartedAt: extractionAttemptStartedAt,
        },
        data: {
          extractionStatus: "FAILED",
          extractionStartedAt: null,
          extractionProvider: "gemini",
          extractionError: message,
        },
      });

      if (failedUpdate.count > 0) {
        const failedDocument = await prisma.document.findUnique({
          where: { id: documentIdForError },
          select: { userId: true, filingDraftId: true, fileName: true },
        });
        if (failedDocument) {
          await createNotification({
            userId: failedDocument.userId,
            type: "DOCUMENT_PROCESSING",
            title: "Document processing failed",
            message: `${failedDocument.fileName}: ${message}`,
            link: failedDocument.filingDraftId
              ? `/tax/new?draftId=${failedDocument.filingDraftId}`
              : "/tax/new",
          });
        }
      }
    }

    console.error("Error extracting document with Gemini:", error);
    return {
      success: false,
      error:
        process.env.NODE_ENV === "development" && error instanceof Error
          ? error.message
          : "Document extraction failed",
    };
  }
}
