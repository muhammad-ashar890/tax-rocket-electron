"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StepHeading } from "@/components/tax/wizard-ui";
import { OtherEmployerNamesField } from "@/components/tax/filing/other-employer-names-field";
import { formatCnicInput, normalizeIdentityName } from "@/lib/tax/cnic-profile";
import { getTaxYearDateInputBounds } from "@/lib/tax/tax-year-period";
import { isDocumentExtractionLeaseStale } from "@/lib/tax/document-extraction-state";
import {
  getSalaryCertificateFieldKind,
  isSalaryCertificateRequiredField,
  hasRequiredSalaryCertificateAmounts,
  hasRequiredSalaryCertificateEmployer,
  checkSalaryCertificateTaxYear,
} from "@/lib/tax/salary-certificate-fields";
import {
  hasRequiredBankStatementIban,
  isBankStatementIbanLabel,
  validateBankStatementIban,
} from "@/lib/tax/bank-statement-fields";

export type ExtractedTransaction = {
  date?: string | null;
  description: string;
  debit?: string | number | null;
  credit?: string | number | null;
  balance?: string | number | null;
  confidence?: number;
};

export type ExtractedPayload = {
  documentType?: string;
  fields?: Array<{
    label: string;
    value: string | number | boolean | null;
    confidence?: number;
  }>;
  transactions?: ExtractedTransaction[];
  notes?: string[];
};

export type FilingDocumentRecord = {
  id: string;
  fileName: string;
  extractionStatus: string;
  extractionProvider: string | null;
  extractionStartedAt?: string | null;
  extractionError?: string | null;
  extractedAt: string | null;
};

export type WizardDocumentSlot = {
  documentType: string;
  slotKey?: string;
  bankAccountId?: string;
  label: string;
  reason: string;
  required: boolean;
};

type WizardDocumentsStepProps = Readonly<{
  taxYear: number;
  documentSlots: WizardDocumentSlot[];
  uploadedDocuments: Record<string, string>;
  documentRecords: Record<string, FilingDocumentRecord>;
  extractedByDocumentId: Record<string, ExtractedPayload>;
  uploadingDocumentType: string | null;
  extractingDocumentId: string | null;
  reviewingDocumentId: string | null;
  savingDocumentReviewId: string | null;
  mappingDocumentId: string | null;
  documentUploadError: string | null;
  profileSyncNote: string | null;
  uploadFileInputsRef: React.MutableRefObject<
    Record<string, HTMLInputElement | null>
  >;
  triggerDocumentUpload: (documentType: string) => void;
  handleDocumentFileSelected: (
    documentType: string,
    fileList: FileList | null,
  ) => void;
  handleExtractDocument: (documentType: string) => void;
  handleReviewDocument: (documentType: string) => void;
  handleExtractedFieldChange: (
    documentType: string,
    fieldIndex: number,
    value: string,
  ) => void;
  handleExtractedTransactionChange: (
    documentType: string,
    transactionIndex: number,
    patch: Partial<ExtractedTransaction>,
  ) => void;
  handleSaveDocumentReview: (documentType: string) => void;
  handleMapDocument: (documentType: string) => void;
  handleSaveStatementIban: (documentType: string) => void;
  handleSaveSalaryEmployers: (documentType: string) => void;
  isSalaryEmployerDirty: (documentType: string) => boolean;
}>;

export function WizardDocumentsStep({
  taxYear,
  documentSlots,
  uploadedDocuments,
  documentRecords,
  extractedByDocumentId,
  uploadingDocumentType,
  extractingDocumentId,
  reviewingDocumentId,
  savingDocumentReviewId,
  mappingDocumentId,
  documentUploadError,
  profileSyncNote,
  uploadFileInputsRef,
  triggerDocumentUpload,
  handleDocumentFileSelected,
  handleExtractDocument,
  handleReviewDocument,
  handleExtractedFieldChange,
  handleExtractedTransactionChange,
  handleSaveDocumentReview,
  handleMapDocument,
  handleSaveStatementIban,
  handleSaveSalaryEmployers,
  isSalaryEmployerDirty,
}: WizardDocumentsStepProps) {
  const [now, setNow] = useState(() => Date.now());
  const hasProcessingDocument = Object.values(documentRecords).some(
    (document) => document.extractionStatus === "PROCESSING",
  );

  useEffect(() => {
    if (!hasProcessingDocument) return;
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, [hasProcessingDocument]);

  const taxYearBounds = getTaxYearDateInputBounds(taxYear);
  const documentErrorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!documentUploadError) return;
    documentErrorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [documentUploadError]);

  return (
    <div className="space-y-6">
      <StepHeading
        title="Upload your documents"
        description="Upload each document one at a time, then review Gemini's extracted data before mapping it."
      />

      {profileSyncNote && (
        <div
          role="status"
          className="rounded-lg border border-amanah/25 bg-amanah/5 p-3 text-sm text-amanah"
        >
          {profileSyncNote}
        </div>
      )}

      {documentUploadError && (
        <div
          ref={documentErrorRef}
          role="alert"
          className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {documentUploadError}
        </div>
      )}

      <div className="rounded-xl border border-amanah/20 bg-amanah/5 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amanah" />
          <p className="text-sm text-amanah">
            AI will extract salary, tax deducted, account balances, and more
            directly from what you upload. You can review and correct the
            extracted fields before approving the mapping.
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Documents</h3>

        {documentSlots.map((slot) => {
          const slotKey = slot.slotKey ?? slot.documentType;
          const uploadedFileName = uploadedDocuments[slotKey];
          const documentRecord = documentRecords[slotKey];
          const extracted = documentRecord
            ? extractedByDocumentId[documentRecord.id]
            : undefined;
          const isUploading = uploadingDocumentType === slotKey;
          const isExtracting = extractingDocumentId === documentRecord?.id;
          const isProcessing =
            documentRecord?.extractionStatus === "PROCESSING";
          const extractionLeaseStale = isDocumentExtractionLeaseStale(
            documentRecord?.extractionStatus ?? "",
            documentRecord?.extractionStartedAt,
            now,
          );
          const isReviewing = reviewingDocumentId === documentRecord?.id;
          const isSavingReview = savingDocumentReviewId === documentRecord?.id;
          const isMapping = mappingDocumentId === documentRecord?.id;
          const hasExtraction =
            documentRecord?.extractionStatus === "COMPLETED" ||
            documentRecord?.extractionStatus === "MAPPED" ||
            (documentRecord?.extractionStatus === "FAILED" &&
              Boolean(extracted));
          const isMapped = documentRecord?.extractionStatus === "MAPPED";
          const isCnicDocument = slot.documentType === "cnic";
          const isSalaryCertificate =
            slot.documentType === "salary_certificate";
          const isMappableDocument =
            isCnicDocument ||
            slot.documentType === "bank_statement" ||
            isSalaryCertificate;
          const hasFields = Boolean(extracted?.fields?.length);
          const requiredSalaryAmountsReady =
            !isSalaryCertificate ||
            hasRequiredSalaryCertificateAmounts(extracted?.fields);
          // IRIS needs the employer added by its registered name.
          const requiredSalaryEmployerReady =
            !isSalaryCertificate ||
            hasRequiredSalaryCertificateEmployer(extracted?.fields);
          // The certificate must be for THIS return's tax year.
          const salaryTaxYearCheck = isSalaryCertificate
            ? checkSalaryCertificateTaxYear(extracted?.fields, taxYear)
            : { ok: true, error: undefined, certificateTaxYear: null };
          const requiredSalaryTaxYearReady = salaryTaxYearCheck.ok;
          const employerEditsUnsaved =
            isSalaryCertificate && isSalaryEmployerDirty(slotKey);
          const isBankStatement = slot.documentType === "bank_statement";
          // The IBAN is read from the statement; when it is not on it the
          // review shows a blank required field, like the salary amounts.
          const requiredIbanReady =
            !isBankStatement || hasRequiredBankStatementIban(extracted?.fields);
          // A statement mapped before the IBAN was required stays mapped; only
          // the IBAN is editable, with its own save (no re-mapping).
          const ibanEditableAfterMap =
            isMapped && isBankStatement && !requiredIbanReady;
          // The employer names stay editable after mapping (own save, no
          // re-extraction): the taxpayer may only learn the exact IRIS name
          // when the FBR list is open.
          const employersEditableAfterMap = isMapped && isSalaryCertificate;
          const ibanProblem =
            isBankStatement && extracted?.fields
              ? validateBankStatementIban(extracted.fields).error
              : "";

          return (
            <div
              key={slotKey}
              className={`overflow-hidden rounded-lg border text-sm ${
                slot.required
                  ? "border-amanah/20 bg-amanah/5"
                  : "border-dashed opacity-90"
              }`}
            >
              <div className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                      uploadedFileName
                        ? "bg-amanah/15 text-amanah"
                        : slot.required
                          ? "bg-amanah/10 text-amanah"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {uploadedFileName ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`font-medium ${slot.required ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {slot.label}
                      </span>
                      {slot.required ? (
                        <Badge
                          variant="outline"
                          className="border-amanah/25 bg-amanah/10 px-1.5 py-0 text-[10px] text-amanah"
                        >
                          Required
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">
                          Optional
                        </span>
                      )}
                      {isMapped && (
                        <Badge
                          variant="outline"
                          className="border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700"
                        >
                          Mapped
                        </Badge>
                      )}
                      {hasExtraction && !isMapped && (
                        <Badge
                          variant="outline"
                          className="border-blue-200 bg-blue-50 px-1.5 py-0 text-[10px] text-blue-700"
                        >
                          {isMappableDocument
                            ? "Review & map"
                            : "Extraction complete"}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {uploadedFileName
                        ? `Uploaded: ${uploadedFileName}`
                        : slot.reason}
                    </p>
                    {isProcessing && !extractionLeaseStale && (
                      <p role="status" className="mt-1 text-xs text-blue-700">
                        Extraction is running. This status and the result will
                        be restored if you refresh.
                      </p>
                    )}
                    {isProcessing && extractionLeaseStale && (
                      <p role="status" className="mt-1 text-xs text-amber-700">
                        This attempt looks stuck. Choose Retry extraction; you
                        do not need to replace the document.
                      </p>
                    )}
                    {documentRecord?.extractionStatus === "FAILED" &&
                      documentRecord.extractionError && (
                        <p
                          role="alert"
                          className="mt-1 text-xs text-destructive"
                        >
                          {documentRecord.extractionError}
                        </p>
                      )}
                  </div>
                </div>

                <input
                  ref={(element) => {
                    uploadFileInputsRef.current[slotKey] = element;
                  }}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(event) => {
                    handleDocumentFileSelected(slotKey, event.target.files);
                    event.currentTarget.value = "";
                  }}
                />

                <div className="flex w-full shrink-0 gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant={uploadedFileName ? "outline" : "default"}
                    size="sm"
                    className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                    onClick={() => triggerDocumentUpload(slotKey)}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    {isUploading
                      ? "Uploading..."
                      : uploadedFileName
                        ? "Replace"
                        : "Upload"}
                  </Button>

                  {uploadedFileName && documentRecord && !hasExtraction && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                      onClick={() => handleExtractDocument(slotKey)}
                      disabled={
                        isExtracting || (isProcessing && !extractionLeaseStale)
                      }
                    >
                      {isExtracting ||
                      (isProcessing && !extractionLeaseStale) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {isExtracting
                        ? "Extracting..."
                        : isProcessing
                          ? extractionLeaseStale
                            ? "Retry extraction"
                            : "Extracting..."
                          : "Extract"}
                    </Button>
                  )}

                  {uploadedFileName &&
                    documentRecord &&
                    hasExtraction &&
                    !extracted && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                        onClick={() => handleReviewDocument(slotKey)}
                        disabled={isReviewing}
                      >
                        {isReviewing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : isMapped ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                        {isReviewing
                          ? "Loading..."
                          : isMapped
                            ? "View mapped data"
                            : isMappableDocument
                              ? "Review & map data"
                              : "Review extracted data"}
                      </Button>
                    )}

                  {uploadedFileName && documentRecord && extracted && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                      disabled
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {isMapped ? "Mapped" : "Reviewed"}
                    </Button>
                  )}
                </div>
              </div>

              {extracted && (
                <div className="border-t bg-background/70 p-4">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {isMapped
                          ? "Mapped extracted data"
                          : "Review extracted data"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isMapped
                          ? employersEditableAfterMap
                            ? "This document is already mapped. The values below are read-only, except the employer names: change them and press Save employer."
                            : "This document is already mapped. The persisted values below are read-only."
                          : "Check the values below before approving and mapping this document."}
                      </p>
                    </div>

                    {ibanEditableAfterMap && (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleSaveStatementIban(slotKey)}
                          disabled={isSavingReview}
                        >
                          {isSavingReview ? "Saving IBAN..." : "Save IBAN"}
                        </Button>
                      </div>
                    )}

                    {employersEditableAfterMap && (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleSaveSalaryEmployers(slotKey)}
                          disabled={
                            isSavingReview ||
                            !requiredSalaryEmployerReady ||
                            !employerEditsUnsaved
                          }
                        >
                          {isSavingReview
                            ? "Saving employer..."
                            : employerEditsUnsaved
                              ? "Save employer"
                              : "Employer saved"}
                        </Button>
                      </div>
                    )}

                    {!isMapped && (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        {isMappableDocument ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleMapDocument(slotKey)}
                            disabled={
                              isMapping ||
                              isSavingReview ||
                              !hasFields ||
                              !requiredSalaryAmountsReady ||
                              !requiredSalaryEmployerReady ||
                              !requiredSalaryTaxYearReady ||
                              !requiredIbanReady
                            }
                          >
                            {isMapping
                              ? isCnicDocument
                                ? "Saving & updating profile..."
                                : "Saving & mapping..."
                              : isCnicDocument
                                ? "Approve & update profile"
                                : "Save & Approve Map"}
                          </Button>
                        ) : (
                          <span className="self-center text-xs text-muted-foreground">
                            Mapping for this document type is not available yet.
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {isBankStatement && (
                    <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                      The account IBAN (24 characters, starts with PK) is
                      required: FBR IRIS lists each bank in your Wealth
                      Statement by IBAN. It is read from the statement; if it is
                      not printed on it, type it in the IBAN field below.
                      {ibanEditableAfterMap
                        ? " This statement was mapped before the IBAN was required — enter it and press Save IBAN. Nothing else is re-mapped."
                        : ""}
                    </p>
                  )}

                  {isSalaryCertificate && (
                    <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                      Annual gross salary and annual tax deducted under Section
                      149 are required. Verify both against the certificate;
                      enter 0 only if the certificate confirms that no salary
                      tax was withheld.
                    </p>
                  )}

                  {hasFields ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {extracted.fields?.map((field, fieldIndex) => {
                        const normalizedFieldLabel = field.label
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "_");
                        const isStatementDateField =
                          /statement|from_date|to_date|transaction|value_date/.test(
                            normalizedFieldLabel,
                          );
                        const isIdentityDateField = [
                          "date_of_birth",
                          "dob",
                          "birth_date",
                          "expiry_date",
                          "expiry",
                          "valid_upto",
                          "valid_until",
                          "date_of_expiry",
                        ].includes(normalizedFieldLabel);
                        const isCnicField = [
                          "cnic_number",
                          "cnic",
                          "identity_number",
                        ].includes(normalizedFieldLabel);
                        const isNameField = [
                          "name",
                          "full_name",
                          "taxpayer_name",
                        ].includes(normalizedFieldLabel);
                        const isDateField =
                          isStatementDateField || isIdentityDateField;
                        const displayValue = isCnicField
                          ? formatCnicInput(field.value)
                          : isNameField
                            ? normalizeIdentityName(field.value)
                            : String(field.value ?? "");

                        if (
                          isSalaryCertificate &&
                          getSalaryCertificateFieldKind(field.label) ===
                            "other_employers"
                        ) {
                          return (
                            <OtherEmployerNamesField
                              key={`${field.label}-${fieldIndex}`}
                              value={String(field.value ?? "")}
                              readOnly={isMapped && !employersEditableAfterMap}
                              onChange={(next) =>
                                handleExtractedFieldChange(
                                  slotKey,
                                  fieldIndex,
                                  next,
                                )
                              }
                            />
                          );
                        }

                        return (
                          <label
                            key={`${field.label}-${fieldIndex}`}
                            className="grid gap-1"
                          >
                            <span className="text-xs font-medium text-muted-foreground">
                              {field.label}
                              {isSalaryCertificate &&
                                isSalaryCertificateRequiredField(
                                  field.label,
                                ) && (
                                  <span className="ml-1 text-destructive">
                                    · Required
                                  </span>
                                )}
                              {isBankStatement &&
                                isBankStatementIbanLabel(field.label) && (
                                  <span className="ml-1 text-destructive">
                                    · Required
                                  </span>
                                )}
                              {typeof field.confidence === "number" &&
                                field.confidence > 0 &&
                                ` · ${Math.round(field.confidence * 100)}% confidence`}
                            </span>
                            <input
                              type={isDateField ? "date" : "text"}
                              min={
                                isStatementDateField
                                  ? taxYearBounds.min
                                  : undefined
                              }
                              max={
                                isStatementDateField
                                  ? taxYearBounds.max
                                  : undefined
                              }
                              inputMode={isCnicField ? "numeric" : undefined}
                              required={Boolean(
                                (isSalaryCertificate &&
                                  isSalaryCertificateRequiredField(
                                    field.label,
                                  )) ||
                                (isBankStatement &&
                                  isBankStatementIbanLabel(field.label)),
                              )}
                              aria-required={Boolean(
                                (isSalaryCertificate &&
                                  isSalaryCertificateRequiredField(
                                    field.label,
                                  )) ||
                                (isBankStatement &&
                                  isBankStatementIbanLabel(field.label)),
                              )}
                              aria-invalid={Boolean(
                                isBankStatement &&
                                isBankStatementIbanLabel(field.label) &&
                                ibanProblem,
                              )}
                              placeholder={
                                isBankStatement &&
                                isBankStatementIbanLabel(field.label)
                                  ? "PK36SCBL0000001123456702"
                                  : undefined
                              }
                              maxLength={
                                isBankStatement &&
                                isBankStatementIbanLabel(field.label)
                                  ? 24
                                  : isCnicField
                                    ? 15
                                    : undefined
                              }
                              value={displayValue}
                              onChange={(event) =>
                                handleExtractedFieldChange(
                                  slotKey,
                                  fieldIndex,
                                  event.target.value,
                                )
                              }
                              readOnly={
                                isMapped &&
                                !(
                                  ibanEditableAfterMap &&
                                  isBankStatementIbanLabel(field.label)
                                ) &&
                                !(
                                  employersEditableAfterMap &&
                                  ["employer_name", "other_employers"].includes(
                                    getSalaryCertificateFieldKind(
                                      field.label,
                                    ) ?? "",
                                  )
                                )
                              }
                              className="h-9 rounded-lg border bg-background px-3 text-sm"
                            />
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                      Gemini did not return any reviewable fields. Do not map
                      this document until extraction is corrected.
                    </p>
                  )}

                  {isBankStatement && hasFields && !requiredIbanReady && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                    >
                      IBAN: {ibanProblem}. Enter the IBAN printed on this bank
                      statement before mapping it.
                    </p>
                  )}

                  {isSalaryCertificate &&
                    hasFields &&
                    !requiredSalaryAmountsReady && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        Enter a positive annual gross salary and the annual tax
                        deducted amount. Use 0 only after confirming no tax was
                        withheld.
                      </p>
                    )}

                  {isSalaryCertificate &&
                    hasFields &&
                    requiredSalaryAmountsReady &&
                    !requiredSalaryEmployerReady && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        Enter the employer name exactly as it is registered with
                        FBR. The agent adds it on IRIS by name, and the name
                        must match IRIS&apos;s list. If you had more than one
                        employer this year, add each one under &quot;Other
                        employers&quot; with the Add employer button.
                      </p>
                    )}

                  {isSalaryCertificate &&
                    hasFields &&
                    !isMapped &&
                    requiredSalaryAmountsReady &&
                    requiredSalaryEmployerReady &&
                    !requiredSalaryTaxYearReady && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        {salaryTaxYearCheck.error}
                      </p>
                    )}

                  {employerEditsUnsaved && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                    >
                      The employer names were changed but not saved yet. Press
                      Save employer before you continue.
                    </p>
                  )}

                  {extracted.transactions &&
                    extracted.transactions.length > 0 && (
                      <div className="mt-5 space-y-2">
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            Extracted transactions
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Review transaction rows before mapping them into
                            Bank Intelligence.
                          </p>
                        </div>
                        <div className="overflow-x-auto rounded-lg border">
                          <table className="min-w-[720px] w-full text-left text-xs">
                            <thead className="border-b bg-muted/20 text-muted-foreground">
                              <tr>
                                <th className="px-2 py-2">Date</th>
                                <th className="px-2 py-2">Description</th>
                                <th className="px-2 py-2">Debit</th>
                                <th className="px-2 py-2">Credit</th>
                                <th className="px-2 py-2">Balance</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {extracted.transactions.map(
                                (transaction, transactionIndex) => (
                                  <tr
                                    key={`${transaction.description}-${transactionIndex}`}
                                  >
                                    <td className="px-2 py-2">
                                      <input
                                        value={String(transaction.date ?? "")}
                                        onChange={(event) =>
                                          handleExtractedTransactionChange(
                                            slotKey,
                                            transactionIndex,
                                            { date: event.target.value },
                                          )
                                        }
                                        readOnly={isMapped}
                                        className="h-8 w-32 rounded border bg-background px-2"
                                      />
                                    </td>
                                    <td className="px-2 py-2">
                                      <input
                                        value={transaction.description}
                                        onChange={(event) =>
                                          handleExtractedTransactionChange(
                                            slotKey,
                                            transactionIndex,
                                            { description: event.target.value },
                                          )
                                        }
                                        readOnly={isMapped}
                                        className="h-8 w-56 rounded border bg-background px-2"
                                      />
                                    </td>
                                    {(
                                      ["debit", "credit", "balance"] as const
                                    ).map((key) => (
                                      <td key={key} className="px-2 py-2">
                                        <input
                                          value={String(transaction[key] ?? "")}
                                          onChange={(event) =>
                                            handleExtractedTransactionChange(
                                              slot.documentType,
                                              transactionIndex,
                                              { [key]: event.target.value },
                                            )
                                          }
                                          readOnly={isMapped}
                                          className="h-8 w-28 rounded border bg-background px-2"
                                        />
                                      </td>
                                    ))}
                                  </tr>
                                ),
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                  {extracted.transactions &&
                    extracted.transactions.length === 0 &&
                    slot.documentType === "bank_statement" && (
                      <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        No transaction rows were found in this statement. You
                        can add missing rows manually in Bank Intelligence after
                        mapping.
                      </p>
                    )}

                  {extracted.notes && extracted.notes.length > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {extracted.notes.join(" ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
