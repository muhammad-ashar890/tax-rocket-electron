import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken, JOB_STATUSES } from "@/lib/tax/fbr-desktop";

/**
 * POST /api/local-agent/jobs/next
 * Electron agent polls for next job
 * Body: { deviceToken, filingDraftId? }
 *
 * Returns next job if available, or null if none
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}) as any);
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const deviceToken =
      (body as any)?.deviceToken ||
      (body as any)?.deviceAuthToken ||
      bearerToken;
    const { filingDraftId } = body as any;

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

    // Update last seen
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    // Find next job
    // Priority: jobs assigned to this device in created/offered status, then unassigned jobs for user's waiting drafts
    let job = null;

    // 1. Jobs already offered to this device.
    // Do NOT claim awaiting_user_action — that status means the human
    // must Resume in the web app first. Re-claiming it restarts the
    // assisted flow from phase "start" and loops on password_reset.
    job = await prisma.localAgentJob.findFirst({
      where: {
        trustedDeviceId: device.id,
        status: {
          in: [JOB_STATUSES.CREATED, JOB_STATUSES.OFFERED_TO_DEVICE],
        },
      },
      orderBy: { createdAt: "asc" },
      include: {
        filingDraft: { select: { id: true, taxYear: true, filerType: true } },
      },
    });

    // 2. If no job offered, find unassigned jobs for this user's drafts
    if (!job) {
      const whereClause: any = {
        userId: device.userId,
        trustedDeviceId: null,
        status: JOB_STATUSES.CREATED,
      };

      if (filingDraftId) {
        whereClause.filingDraftId = filingDraftId;
      }

      job = await prisma.localAgentJob.findFirst({
        where: whereClause,
        orderBy: { createdAt: "asc" },
        include: {
          filingDraft: { select: { id: true, taxYear: true, filerType: true } },
        },
      });

      // If found unassigned job, assign it to this device
      if (job) {
        job = await prisma.localAgentJob.update({
          where: { id: job.id },
          data: {
            trustedDeviceId: device.id,
            status: JOB_STATUSES.OFFERED_TO_DEVICE,
          },
          include: {
            filingDraft: {
              select: { id: true, taxYear: true, filerType: true },
            },
          },
        });
      }
    }

    // 3. If still no job, check if there are filing drafts waiting for agent that need a job created
    // This is auto-creation for dry_run if FbrConnection is WAITING_FOR_AGENT or AGENT_CONNECTED
    if (!job) {
      const waitingConnections = await prisma.fbrConnection.findMany({
        where: {
          userId: device.userId,
          status: { in: ["WAITING_FOR_AGENT", "AGENT_CONNECTED"] },
          ...(filingDraftId ? { filingDraftId } : {}),
        },
        include: {
          filingDraft: { select: { id: true, taxYear: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      });

      // For now, don't auto-create jobs - jobs must be created via UI action (queue dry run)
      // This prevents accidental filing
    }

    if (!job) {
      return NextResponse.json({
        success: true,
        ok: true,
        job: null,
        message: "No jobs available",
      });
    }

    // Parse payload
    let payload: any = {};
    try {
      payload = JSON.parse(job.payloadJson);
    } catch {}

    return NextResponse.json({
      success: true,
      ok: true,
      job: {
        id: job.id,
        publicId: job.id,
        type: job.jobType,
        jobType: job.jobType,
        status: job.status,
        filingDraftId: job.filingDraftId,
        filingDraft: job.filingDraft,
        payload,
        pauseAction: job.pauseAction,
        pauseMessage: job.pauseMessage,
        createdAt: job.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Error fetching next job:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch job" },
      { status: 500 },
    );
  }
}
