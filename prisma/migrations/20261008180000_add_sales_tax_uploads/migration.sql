-- CreateTable
CREATE TABLE "SalesTaxUpload" (
    "id" TEXT NOT NULL,
    "filingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "grid" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTaxUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesTaxUpload_filingId_kind_key" ON "SalesTaxUpload"("filingId", "kind");

-- AddForeignKey
ALTER TABLE "SalesTaxUpload" ADD CONSTRAINT "SalesTaxUpload_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "SalesTaxFiling"("id") ON DELETE CASCADE ON UPDATE CASCADE;
