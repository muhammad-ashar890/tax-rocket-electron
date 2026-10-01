-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "iban" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_filingDraftId_iban_key" ON "BankAccount"("filingDraftId", "iban");
