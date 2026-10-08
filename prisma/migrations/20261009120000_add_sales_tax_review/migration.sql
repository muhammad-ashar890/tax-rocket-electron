-- AlterTable
ALTER TABLE "SalesTaxFiling" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedPacket" JSONB,
ADD COLUMN     "figures" JSONB;
