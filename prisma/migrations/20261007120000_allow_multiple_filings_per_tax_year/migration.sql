-- A taxpayer may have more than one filing for the same tax year (for example
-- the salary return filed first and a business return filed later). The unique
-- index forced a single draft per user and year, so starting a second filing
-- overwrote the first one. Replace it with a plain lookup index.

-- DropIndex
DROP INDEX "FilingDraft_userId_taxYear_key";

-- CreateIndex
CREATE INDEX "FilingDraft_userId_taxYear_idx" ON "FilingDraft"("userId", "taxYear");
