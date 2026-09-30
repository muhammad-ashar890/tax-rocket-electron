export type FilingDocumentSlotResolution =
  | {
      success: true;
      documentType: string;
      bankAccountId: string | null;
    }
  | {
      success: false;
      error: string;
    };

const BANK_STATEMENT_TYPE = "bank_statement";
const BANK_STATEMENT_SLOT_PREFIX = `${BANK_STATEMENT_TYPE}:`;

/**
 * Builds an exact document-slot predicate. Keeping `bankAccountId: null` for
 * non-bank documents is intentional: omitting the property would make the
 * lookup span every account-linked document of the same type.
 */
export function buildFilingDocumentSlotWhere(
  filingDraftId: string,
  userId: string,
  documentType: string,
  bankAccountId: string | null,
) {
  return { filingDraftId, userId, documentType, bankAccountId };
}

/** Builds the only valid bank-statement cleanup boundary. */
export function buildBankStatementCleanupWhere(
  filingDraftId: string,
  userId: string,
  bankAccountId: string,
  previousDocumentId: string,
) {
  return {
    filingDraftId,
    userId,
    OR: [{ sourceDocumentId: previousDocumentId }, { bankAccountId }],
  };
}

/**
 * Resolves the authoritative server-side identity of a filing-document slot.
 *
 * Bank statements must always identify one configured account. The account ID
 * embedded in `bank_statement:<id>` cannot be overridden by another form field,
 * and non-bank documents cannot be linked to a bank account.
 */
export function resolveFilingDocumentSlot(
  requestedDocumentType: string,
  suppliedBankAccountId?: string | null,
): FilingDocumentSlotResolution {
  const requestedType = requestedDocumentType.trim();
  const suppliedAccountId = suppliedBankAccountId?.trim() || null;

  if (requestedType.startsWith(BANK_STATEMENT_SLOT_PREFIX)) {
    const slotAccountId = requestedType
      .slice(BANK_STATEMENT_SLOT_PREFIX.length)
      .trim();

    if (!slotAccountId) {
      return {
        success: false,
        error: "Select the bank account for this statement",
      };
    }

    if (suppliedAccountId && suppliedAccountId !== slotAccountId) {
      return {
        success: false,
        error: "Bank statement slot does not match the selected account",
      };
    }

    return {
      success: true,
      documentType: BANK_STATEMENT_TYPE,
      bankAccountId: slotAccountId,
    };
  }

  if (requestedType === BANK_STATEMENT_TYPE) {
    if (!suppliedAccountId) {
      return {
        success: false,
        error: "Select the bank account for this statement",
      };
    }

    return {
      success: true,
      documentType: BANK_STATEMENT_TYPE,
      bankAccountId: suppliedAccountId,
    };
  }

  if (suppliedAccountId) {
    return {
      success: false,
      error: "Only bank statements can be linked to a bank account",
    };
  }

  return {
    success: true,
    documentType: requestedType,
    bankAccountId: null,
  };
}
