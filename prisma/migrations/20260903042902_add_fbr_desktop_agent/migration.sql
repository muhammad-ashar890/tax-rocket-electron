-- AlterTable
ALTER TABLE "FbrConnection" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "partitionKey" TEXT;

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceName" TEXT DEFAULT 'TaxRocket Desktop',
    "deviceTokenHash" TEXT NOT NULL,
    "partitionKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "localFbrConnectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalAgentJob" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trustedDeviceId" TEXT,
    "jobType" TEXT NOT NULL DEFAULT 'tax_dry_run',
    "status" TEXT NOT NULL DEFAULT 'created',
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT,
    "errorMessage" TEXT,
    "screenshotsJson" TEXT DEFAULT '[]',
    "logsJson" TEXT DEFAULT '[]',
    "pauseAction" TEXT,
    "pauseMessage" TEXT,
    "resumeDataJson" TEXT,
    "expiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalAgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxAuditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filingDraftId" TEXT,
    "jobId" TEXT,
    "deviceId" TEXT,
    "eventType" TEXT NOT NULL,
    "eventDataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_deviceTokenHash_key" ON "TrustedDevice"("deviceTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_partitionKey_key" ON "TrustedDevice"("partitionKey");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");

-- CreateIndex
CREATE INDEX "TrustedDevice_status_idx" ON "TrustedDevice"("status");

-- CreateIndex
CREATE INDEX "LocalAgentJob_userId_idx" ON "LocalAgentJob"("userId");

-- CreateIndex
CREATE INDEX "LocalAgentJob_filingDraftId_idx" ON "LocalAgentJob"("filingDraftId");

-- CreateIndex
CREATE INDEX "LocalAgentJob_trustedDeviceId_idx" ON "LocalAgentJob"("trustedDeviceId");

-- CreateIndex
CREATE INDEX "LocalAgentJob_status_idx" ON "LocalAgentJob"("status");

-- CreateIndex
CREATE INDEX "LocalAgentJob_jobType_idx" ON "LocalAgentJob"("jobType");

-- CreateIndex
CREATE INDEX "TaxAuditEvent_userId_idx" ON "TaxAuditEvent"("userId");

-- CreateIndex
CREATE INDEX "TaxAuditEvent_filingDraftId_idx" ON "TaxAuditEvent"("filingDraftId");

-- CreateIndex
CREATE INDEX "TaxAuditEvent_eventType_idx" ON "TaxAuditEvent"("eventType");

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalAgentJob" ADD CONSTRAINT "LocalAgentJob_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalAgentJob" ADD CONSTRAINT "LocalAgentJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalAgentJob" ADD CONSTRAINT "LocalAgentJob_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAuditEvent" ADD CONSTRAINT "TaxAuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxAuditEvent" ADD CONSTRAINT "TaxAuditEvent_filingDraftId_fkey" FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
