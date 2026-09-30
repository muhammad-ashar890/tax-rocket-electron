-- AlterTable
ALTER TABLE "FilingDraft"
ADD COLUMN "taxpayerListStatus" TEXT,
ADD COLUMN "taxpayerListStatusSource" TEXT,
ADD COLUMN "taxpayerListStatusCheckedAt" TIMESTAMP(3),
ADD COLUMN "taxRuleSetVersion" TEXT,
ADD COLUMN "taxCalculationRevision" TEXT;

-- CreateTable
CREATE TABLE "FilingIncomeSelection" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "selectionSource" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'SELECTED',
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FilingIncomeSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingIncomeRecord" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "taxableAmount" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "recordStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "sourceDocumentId" TEXT,
    "sourceTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FilingIncomeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingTaxCredit" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "ruleId" TEXT,
    "source" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "treatment" TEXT NOT NULL DEFAULT 'UNCONFIRMED',
    "creditStatus" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "sourceDocumentId" TEXT,
    "sourceTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FilingTaxCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingTaxCalculationLine" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "calculationRevision" TEXT NOT NULL,
    "ruleSetVersion" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "filerStatusUsed" TEXT NOT NULL,
    "taxBase" DECIMAL(18,2) NOT NULL,
    "baseTax" DECIMAL(18,2) NOT NULL,
    "surcharge" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "calculatedTax" DECIMAL(18,2) NOT NULL,
    "taxCreditApplied" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "refundDue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FilingTaxCalculationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FilingIncomeSelection_filingDraftId_source_subcategory_key" ON "FilingIncomeSelection"("filingDraftId", "source", "subcategory");
CREATE INDEX "FilingIncomeSelection_filingDraftId_idx" ON "FilingIncomeSelection"("filingDraftId");
CREATE INDEX "FilingIncomeSelection_userId_idx" ON "FilingIncomeSelection"("userId");
CREATE INDEX "FilingIncomeSelection_source_subcategory_idx" ON "FilingIncomeSelection"("source", "subcategory");

CREATE UNIQUE INDEX "FilingIncomeRecord_filingDraftId_sourceTransactionId_key" ON "FilingIncomeRecord"("filingDraftId", "sourceTransactionId");
CREATE INDEX "FilingIncomeRecord_filingDraftId_idx" ON "FilingIncomeRecord"("filingDraftId");
CREATE INDEX "FilingIncomeRecord_userId_idx" ON "FilingIncomeRecord"("userId");
CREATE INDEX "FilingIncomeRecord_source_subcategory_idx" ON "FilingIncomeRecord"("source", "subcategory");
CREATE INDEX "FilingIncomeRecord_sourceDocumentId_idx" ON "FilingIncomeRecord"("sourceDocumentId");

CREATE UNIQUE INDEX "FilingTaxCredit_filingDraftId_sourceTransactionId_section_key" ON "FilingTaxCredit"("filingDraftId", "sourceTransactionId", "section");
CREATE INDEX "FilingTaxCredit_filingDraftId_idx" ON "FilingTaxCredit"("filingDraftId");
CREATE INDEX "FilingTaxCredit_userId_idx" ON "FilingTaxCredit"("userId");
CREATE INDEX "FilingTaxCredit_section_idx" ON "FilingTaxCredit"("section");
CREATE INDEX "FilingTaxCredit_ruleId_idx" ON "FilingTaxCredit"("ruleId");
CREATE INDEX "FilingTaxCredit_sourceDocumentId_idx" ON "FilingTaxCredit"("sourceDocumentId");

CREATE INDEX "FilingTaxCalculationLine_filingDraftId_calculationRevision_idx" ON "FilingTaxCalculationLine"("filingDraftId", "calculationRevision");
CREATE INDEX "FilingTaxCalculationLine_userId_idx" ON "FilingTaxCalculationLine"("userId");
CREATE INDEX "FilingTaxCalculationLine_ruleId_idx" ON "FilingTaxCalculationLine"("ruleId");
CREATE INDEX "FilingTaxCalculationLine_source_subcategory_idx" ON "FilingTaxCalculationLine"("source", "subcategory");

-- AddForeignKey
ALTER TABLE "FilingIncomeSelection" ADD CONSTRAINT "FilingIncomeSelection_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FilingIncomeSelection" ADD CONSTRAINT "FilingIncomeSelection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FilingIncomeRecord" ADD CONSTRAINT "FilingIncomeRecord_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FilingIncomeRecord" ADD CONSTRAINT "FilingIncomeRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FilingIncomeRecord" ADD CONSTRAINT "FilingIncomeRecord_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FilingIncomeRecord" ADD CONSTRAINT "FilingIncomeRecord_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FilingTaxCredit" ADD CONSTRAINT "FilingTaxCredit_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FilingTaxCredit" ADD CONSTRAINT "FilingTaxCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FilingTaxCredit" ADD CONSTRAINT "FilingTaxCredit_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FilingTaxCredit" ADD CONSTRAINT "FilingTaxCredit_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FilingTaxCalculationLine" ADD CONSTRAINT "FilingTaxCalculationLine_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FilingTaxCalculationLine" ADD CONSTRAINT "FilingTaxCalculationLine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
