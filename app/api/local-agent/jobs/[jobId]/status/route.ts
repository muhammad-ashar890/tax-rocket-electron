import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  hashToken,
  JOB_STATUSES,
  normalizePauseAction,
} from "@/lib/tax/fbr-desktop";

/** Read-only liveness/cancellation check used before desktop navigation steps. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const header = req.headers.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token)
      return NextResponse.json(
        { success: false, ok: false, error: "Bearer device token required" },
        { status: 401 },
      );
    const device = await prisma.trustedDevice.findUnique({
      where: { deviceTokenHash: hashToken(token) },
    });
    if (!device || device.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, ok: false, error: "Invalid device" },
        { status: 401 },
      );
    }
    const job = await prisma.localAgentJob.findFirst({
      where: { id: jobId, userId: device.userId, trustedDeviceId: device.id },
      select: { id: true, status: true, expiresAt: true },
    });
    if (!job)
      return NextResponse.json(
        { success: false, ok: false, error: "Job not found for this device" },
        { status: 404 },
      );
    return NextResponse.json(
      {
        success: true,
        ok: true,
        job: {
          id: job.id,
          status: job.status,
          expired: Boolean(
            job.expiresAt && job.expiresAt.getTime() <= Date.now(),
          ),
          expiresAt: job.expiresAt?.toISOString() || null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Error checking desktop job state:", error);
    return NextResponse.json(
      { success: false, ok: false, error: "Job state unavailable" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/local-agent/jobs/[jobId]/status
 * Electron agent reports job status updates
 * Body: { deviceToken, status, pauseAction?, pauseMessage?, result?, error?, screenshots?, logs?, resumeData? }
 *
 * Handles:
 * - running, awaiting_user_action (pause for OTP etc), completed, failed
 * - Pause actions: otp_required, captcha_required, pin_required, final_review, etc.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const body = await req.json().catch(() => ({}) as any);
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const deviceToken =
      (body as any)?.deviceToken ||
      (body as any)?.deviceAuthToken ||
      bearerToken;
    const {
      status,
      pauseAction,
      pauseMessage,
      result,
      error,
      errorMessage,
      screenshots,
      logs,
      executionLog,
      resumeData,
    } = body as any;

    if (!deviceToken) {
      return NextResponse.json(
        {
          success: false,
          ok: false,
          error: "deviceToken required (body or Bearer)",
        },
        { status: 400 },
      );
    }

    if (!status) {
      return NextResponse.json(
        { success: false, error: "status required" },
        { status: 400 },
      );
    }

    const deviceTokenHash = hashToken(deviceToken);
    const device = await prisma.trustedDevice.findUnique({
      where: { deviceTokenHash },
    });

    if (!device || device.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: "Invalid device" },
        { status: 401 },
      );
    }

    const job = await prisma.localAgentJob.findFirst({
      where: {
        id: jobId,
        userId: device.userId,
      },
    });

    if (!job) {
      return NextResponse.json(
        { success: false, error: "Job not found" },
        { status: 404 },
      );
    }

    // A late worker response must not resurrect a cancelled/expired job.
    if (
      [
        JOB_STATUSES.CANCELLED,
        JOB_STATUSES.COMPLETED,
        JOB_STATUSES.FAILED,
        JOB_STATUSES.EXPIRED,
      ].includes(job.status as any)
    ) {
      return NextResponse.json(
        { success: false, error: `Job is already ${job.status}` },
        { status: 409 },
      );
    }
    if (job.trustedDeviceId && job.trustedDeviceId !== device.id) {
      return NextResponse.json(
        { success: false, error: "Job belongs to a different device" },
        { status: 403 },
      );
    }

    // Validate status transition
    const validStatuses = Object.values(JOB_STATUSES);
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { success: false, error: `Invalid status: ${status}` },
        { status: 400 },
      );
    }

    // Prepare update data
    const updateData: any = {
      status,
      trustedDeviceId: device.id,
    };

    const resultObject =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : null;
    const inferredPauseAction =
      pauseAction ||
      (status === JOB_STATUSES.AWAITING_USER_ACTION
        ? String(resultObject?.requiredAction || "").trim()
        : "");

    if (inferredPauseAction) {
      updateData.pauseAction = normalizePauseAction(inferredPauseAction);
      updateData.pauseMessage =
        pauseMessage ||
        (typeof resultObject?.pauseReason === "string"
          ? resultObject.pauseReason
          : null) ||
        (typeof resultObject?.message === "string"
          ? resultObject.message
          : null);
    } else if (status !== JOB_STATUSES.AWAITING_USER_ACTION) {
      // Clear pause if not awaiting
      updateData.pauseAction = null;
      updateData.pauseMessage = null;
    }

    if (result) {
      updateData.resultJson =
        typeof result === "string" ? result : JSON.stringify(result);
    }

    const reportedError = errorMessage ?? error;
    if (reportedError) {
      updateData.errorMessage =
        typeof reportedError === "string"
          ? reportedError
          : JSON.stringify(reportedError);
    }

    if (screenshots) {
      updateData.screenshotsJson =
        typeof screenshots === "string"
          ? screenshots
          : JSON.stringify(screenshots);
    }

    const reportedLogs = executionLog ?? logs;
    if (reportedLogs) {
      updateData.logsJson =
        typeof reportedLogs === "string"
          ? reportedLogs
          : JSON.stringify(reportedLogs);
    }

    if (resumeData) {
      updateData.resumeDataJson =
        typeof resumeData === "string"
          ? resumeData
          : JSON.stringify(resumeData);
    }

    if (
      status === JOB_STATUSES.COMPLETED ||
      status === JOB_STATUSES.FAILED ||
      status === JOB_STATUSES.CANCELLED ||
      status === JOB_STATUSES.EXPIRED
    ) {
      updateData.completedAt = new Date();
    }

    if (status === JOB_STATUSES.RUNNING && !job.startedAt) {
      updateData.startedAt = new Date();
    }

    const changed = await prisma.localAgentJob.updateMany({
      where: {
        id: jobId,
        status: {
          notIn: [
            JOB_STATUSES.CANCELLED,
            JOB_STATUSES.COMPLETED,
            JOB_STATUSES.FAILED,
            JOB_STATUSES.EXPIRED,
          ],
        },
      },
      data: updateData,
    });
    if (changed.count !== 1) {
      return NextResponse.json(
        {
          success: false,
          error: "Job was closed while the agent was reporting status",
        },
        { status: 409 },
      );
    }
    const updatedJob = await prisma.localAgentJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    // If job completed, update FbrConnection as well
    if (status === JOB_STATUSES.COMPLETED) {
      await prisma.fbrConnection.updateMany({
        where: {
          filingDraftId: job.filingDraftId,
          userId: device.userId,
        },
        data: {
          status:
            job.jobType === "tax_dry_run"
              ? "DRY_RUN_COMPLETED"
              : "FILING_COMPLETED",
          completedAt: new Date(),
          message: `Job ${job.jobType} completed`,
          errorMessage: null,
          lastHeartbeat: new Date(),
        },
      });
    }

    if (status === JOB_STATUSES.FAILED) {
      await prisma.fbrConnection.updateMany({
        where: {
          filingDraftId: job.filingDraftId,
          userId: device.userId,
        },
        data: {
          status: "FAILED",
          errorMessage: updateData.errorMessage || "Job failed",
          lastHeartbeat: new Date(),
        },
      });
    }

    // Audit
    await prisma.taxAuditEvent.create({
      data: {
        userId: device.userId,
        filingDraftId: job.filingDraftId,
        jobId: job.id,
        deviceId: device.id,
        eventType: `JOB_${status.toUpperCase()}`,
        eventDataJson: JSON.stringify({
          jobType: job.jobType,
          pauseAction: updateData.pauseAction,
          hasResult: !!result,
          hasError: !!reportedError,
        }),
      },
    });

    // Update device last seen
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return NextResponse.json({
      success: true,
      ok: true,
      job: {
        id: updatedJob.id,
        status: updatedJob.status,
        pauseAction: updatedJob.pauseAction,
        pauseMessage: updatedJob.pauseMessage,
        completedAt: updatedJob.completedAt?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Error updating job status:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update job status" },
      { status: 500 },
    );
  }
}
