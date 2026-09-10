import { useRef, useState } from "react";
import { describeCnicProfilePlan } from "@/lib/tax/cnic-profile";

import { uploadFilingDocumentAction } from "@/app/actions/documents";
import {
  approveAndMapExtractedDocumentAction,
  extractDocumentWithGeminiAction,
  getDocumentExtractionAction,
  getFilingDocumentsAction,
  updateDocumentExtractionAction,
} from "@/app/actions/extraction";
import { getFilingSummaryAction } from "@/app/actions/filing-summary";
import type { FilingSummary } from "@/components/tax/filing/config/filing-wizard-config";
import type {
  ExtractedPayload,
  ExtractedTransaction,
  FilingDocumentRecord,
} from "@/components/tax/filing/wizard-documents-step";

type ResetDownstreamSteps = (
  resetStep: number,
  preserveReconciliation?: boolean,
) => void;

type UseFilingDocumentsInput = {
  draftId: string | null;
  step: number;
  resetDownstreamSteps: ResetDownstreamSteps;
  setFilingSummary: (summary: FilingSummary) => void;
};

export function useFilingDocuments({
  draftId,
  step,
  resetDownstreamSteps,
  setFilingSummary,
}: UseFilingDocumentsInput) {
  const [uploadedDocuments, setUploadedDocuments] = useState<
    Record<string, string>
  >({});
  const [documentRecords, setDocumentRecords] = useState<
    Record<string, FilingDocumentRecord>
  >({});
  const [extractedByDocumentId, setExtractedByDocumentId] = useState<
    Record<string, ExtractedPayload>
  >({});
  const [extractingDocumentId, setExtractingDocumentId] = useState<
    string | null
  >(null);
  const [reviewingDocumentId, setReviewingDocumentId] = useState<string | null>(
    null,
  );
  const [savingDocumentReviewId, setSavingDocumentReviewId] = useState<
    string | null
  >(null);
  const [mappingDocumentId, setMappingDocumentId] = useState<string | null>(
    null,
  );
  const [selectedDocumentFiles, setSelectedDocumentFiles] = useState<
    Record<string, File>
  >({});
  const [uploadingDocumentType, setUploadingDocumentType] = useState<
    string | null
  >(null);
  const [documentUploadError, setDocumentUploadError] = useState<string | null>(
    null,
  );
  // What an approved CNIC actually changed on the profile. Not an error: when a
  // field is deliberately left alone (a name the human already typed) the operator
  // needs to know that, or the upload looks like it did nothing.
  const [profileSyncNote, setProfileSyncNote] = useState<string | null>(null);
  const uploadFileInputsRef = useRef<Record<string, HTMLInputElement | null>>(
    {},
  );

  function triggerDocumentUpload(documentType: string) {
    uploadFileInputsRef.current[documentType]?.click();
  }

  async function handleDocumentFileSelected(
    documentType: string,
    fileList: FileList | null,
  ) {
    const file = fileList?.[0];
    if (!file) return;

    setDocumentUploadError(null);
    setProfileSyncNote(null);
    setUploadedDocuments((prev) => ({ ...prev, [documentType]: file.name }));
    setSelectedDocumentFiles((prev) => ({ ...prev, [documentType]: file }));

    if (!draftId) return;

    setUploadingDocumentType(documentType);
    const uploadData = new FormData();
    uploadData.set("draftId", draftId);
    uploadData.set("documentType", documentType);
    uploadData.set("file", file);

    const result = await uploadFilingDocumentAction(uploadData);
    setUploadingDocumentType(null);
    setSelectedDocumentFiles((previous) => {
      const next = { ...previous };
      delete next[documentType];
      return next;
    });

    if (result.success) {
      setDocumentRecords((previous) => ({
        ...previous,
        [documentType]: {
          id: result.document.id,
          fileName: result.document.fileName,
          extractionStatus: result.document.extractionStatus,
          extractionProvider: null,
          extractedAt: null,
        },
      }));
      resetDownstreamSteps(step);
      return;
    }

    setDocumentUploadError(result.error ?? "Failed to upload document");
    setUploadedDocuments((prev) => {
      const next = { ...prev };
      delete next[documentType];
      return next;
    });
  }

  async function handleExtractDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;

    setExtractingDocumentId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    const result = await extractDocumentWithGeminiAction(record.id);
    setExtractingDocumentId(null);

    if (!result.success) {
      setDocumentUploadError(
        "error" in result ? result.error : "Document extraction failed",
      );
      setDocumentRecords((previous) => ({
        ...previous,
        [documentType]: { ...record, extractionStatus: "FAILED" },
      }));
      return;
    }

    setDocumentRecords((previous) => ({
      ...previous,
      [documentType]: {
        ...record,
        extractionStatus: "COMPLETED",
        extractionProvider: result.provider ?? "gemini",
        extractedAt: new Date().toISOString(),
      },
    }));
    setExtractedByDocumentId((previous) => ({
      ...previous,
      [record.id]: (result.extracted ?? {
        fields: [],
        notes: [],
      }) as ExtractedPayload,
    }));
    resetDownstreamSteps(step);

    if (draftId) {
      const refreshedSummary = await getFilingSummaryAction(draftId);
      if (refreshedSummary.success) {
        setFilingSummary(refreshedSummary.summary as FilingSummary);
      }
    }
  }

  async function handleReviewDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record || extractedByDocumentId[record.id]) return;

    setReviewingDocumentId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    const result = await getDocumentExtractionAction(record.id);
    setReviewingDocumentId(null);

    if (!result.success) {
      setDocumentUploadError(result.error ?? "Failed to load extracted data");
      return;
    }

    setExtractedByDocumentId((previous) => ({
      ...previous,
      [record.id]: (result.extraction ?? {
        fields: [],
        notes: [],
      }) as ExtractedPayload,
    }));
  }

  function handleExtractedFieldChange(
    documentType: string,
    fieldIndex: number,
    value: string,
  ) {
    const record = documentRecords[documentType];
    if (!record) return;

    setExtractedByDocumentId((previous) => {
      const payload = previous[record.id];
      if (!payload?.fields) return previous;
      const fields = payload.fields.map((field, index) =>
        index === fieldIndex ? { ...field, value } : field,
      );
      return { ...previous, [record.id]: { ...payload, fields } };
    });
  }

  function handleExtractedTransactionChange(
    documentType: string,
    transactionIndex: number,
    patch: Partial<ExtractedTransaction>,
  ) {
    const record = documentRecords[documentType];
    if (!record) return;

    setExtractedByDocumentId((previous) => {
      const payload = previous[record.id];
      if (!payload?.transactions) return previous;
      const transactions = payload.transactions.map((transaction, index) =>
        index === transactionIndex ? { ...transaction, ...patch } : transaction,
      );
      return { ...previous, [record.id]: { ...payload, transactions } };
    });
  }

  async function handleSaveDocumentReview(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;
    const payload = extractedByDocumentId[record.id];
    if (!payload) return;

    setSavingDocumentReviewId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    const result = await updateDocumentExtractionAction(record.id, payload);
    setSavingDocumentReviewId(null);

    if (!result.success) {
      setDocumentUploadError(result.error ?? "Failed to save extracted data");
      return;
    }

    setDocumentRecords((previous) => ({
      ...previous,
      [documentType]: { ...record, extractionStatus: "COMPLETED" },
    }));
  }

  async function handleMapDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;

    setMappingDocumentId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    const extracted = extractedByDocumentId[record.id];
    if (!extracted) {
      setMappingDocumentId(null);
      setDocumentUploadError("Review the extracted data before mapping");
      return;
    }

    const saveResult = await updateDocumentExtractionAction(
      record.id,
      extracted,
    );
    if (!saveResult.success) {
      setMappingDocumentId(null);
      setDocumentUploadError(saveResult.error ?? "Failed to save corrections");
      return;
    }

    const result = await approveAndMapExtractedDocumentAction(record.id);
    setMappingDocumentId(null);
    if (!result.success) {
      setDocumentUploadError(
        result.error ?? "Failed to map extracted document",
      );
      return;
    }

    setProfileSyncNote(
      describeCnicProfilePlan(
        (
          result as {
            profilePlan?: { filled?: string[]; skipped?: { field: string }[] };
          }
        ).profilePlan,
      ),
    );

    setDocumentRecords((previous) => ({
      ...previous,
      [documentType]: { ...record, extractionStatus: "MAPPED" },
    }));

    if (draftId) {
      const refreshedSummary = await getFilingSummaryAction(draftId);
      if (refreshedSummary.success) {
        setFilingSummary(refreshedSummary.summary as FilingSummary);
      }
    }
  }

  return {
    uploadedDocuments,
    documentRecords,
    extractedByDocumentId,
    extractingDocumentId,
    reviewingDocumentId,
    savingDocumentReviewId,
    mappingDocumentId,
    selectedDocumentFiles,
    uploadingDocumentType,
    documentUploadError,
    profileSyncNote,
    setProfileSyncNote,
    uploadFileInputsRef,
    setUploadedDocuments,
    setDocumentRecords,
    setSelectedDocumentFiles,
    setUploadingDocumentType,
    setDocumentUploadError,
    triggerDocumentUpload,
    handleDocumentFileSelected,
    handleExtractDocument,
    handleReviewDocument,
    handleExtractedFieldChange,
    handleExtractedTransactionChange,
    handleSaveDocumentReview,
    handleMapDocument,
  };
}
