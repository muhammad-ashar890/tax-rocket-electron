-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "BankStatement" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "bankAccountId" TEXT;

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountLabel" TEXT NOT NULL,
    "accountNumberMasked" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_filingDraftId_idx" ON "BankAccount"("filingDraftId");

-- CreateIndex
CREATE INDEX "BankAccount_userId_idx" ON "BankAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_filingDraftId_accountLabel_key" ON "BankAccount"("filingDraftId", "accountLabel");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_filingDraftId_sourceTransactionId_key" ON "LedgerEntry"("filingDraftId", "sourceTransactionId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
