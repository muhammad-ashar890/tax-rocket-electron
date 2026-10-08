-- CreateTable
CREATE TABLE "SalesTaxProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "registrationNo" TEXT NOT NULL,
    "authorities" TEXT NOT NULL DEFAULT '["FBR"]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTaxFiling" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTaxFiling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesTaxProfile_userId_key" ON "SalesTaxProfile"("userId");

-- CreateIndex
CREATE INDEX "SalesTaxFiling_userId_idx" ON "SalesTaxFiling"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTaxFiling_userId_authority_periodYear_periodMonth_key" ON "SalesTaxFiling"("userId", "authority", "periodYear", "periodMonth");

-- AddForeignKey
ALTER TABLE "SalesTaxProfile" ADD CONSTRAINT "SalesTaxProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTaxFiling" ADD CONSTRAINT "SalesTaxFiling_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
