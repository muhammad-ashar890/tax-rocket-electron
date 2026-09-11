-- Explicit taxpayer residency choice for the IRIS new-return context.
-- NULL is retained for legacy/incomplete drafts; downstream packet/agent gates
-- refuse to proceed until the user selects Resident or Non-Resident.
ALTER TABLE "FilingDraft" ADD COLUMN "residencyStatus" TEXT;
