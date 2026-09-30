"use server";

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/app/actions/notifications";
import { getNextFbrPilotPhase } from "@/lib/tax/fbr-job-resume";
import { JOB_STATUSES, JOB_TYPES } from "@/lib/tax/fbr-desktop";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) throw new Error("User profile not found");
  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: { id: true, userId: true, taxYear: true },
  });
  if (!draft) throw new Error("Filing draft not found");
  return draft;
}

export async function queueDryRunJobAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);

    const latestPacket = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
        approvalStatus: "APPROVED",
      },
      orderBy: { version: "desc" },
    });

    if (!latestPacket) {
      return {
        success: false,
        error: "No approved packet. Generate packet first.",
      };
    }

    // Check if there's already a running job
    const existingRunning = await prisma.localAgentJob.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: {
          in: [
            JOB_STATUSES.CREATED,
            JOB_STATUSES.OFFERED_TO_DEVICE,
            JOB_STATUSES.ACCEPTED_BY_DEVICE,
            JOB_STATUSES.RUNNING,
            JOB_STATUSES.AWAITING_USER_ACTION,
          ],
        },
      },
    });

    if (existingRunning) {
      return {
        success: false,
        error: `Already have a ${existingRunning.jobType} job in ${existingRunning.status} status. Complete or cancel it first.`,
      };
    }

    const job = await prisma.localAgentJob.create({
      data: {
        filingDraftId: draft.id,
        userId: draft.userId,
        jobType: JOB_TYPES.TAX_DRY_RUN,
        status: JOB_STATUSES.CREATED,
        payloadJson: JSON.stringify({
          packetId: latestPacket.id,
          packetVersion: latestPacket.version,
          packetHash: latestPacket.packetHash,
          taxYear: draft.taxYear,
          createdAt: new Date().toISOString(),
          dryRun: true,
          stopAtReviewGate: true,
        }),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
      },
    });

    await prisma.fbrConnection.upsert({
      where: { filingDraftId: draft.id },
      update: {
        status: "DRY_RUN_QUEUED",
        message: `Dry run job queued (packet v${latestPacket.version})`,
        lastHeartbeat: new Date(),
      },
      create: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: "DRY_RUN_QUEUED",
        message: `Dry run job queued (packet v${latestPacket.version})`,
        startedAt: new Date(),
      },
    });

    await prisma.taxAuditEvent.create({
      data: {
        userId: draft.userId,
        filingDraftId: draft.id,
        jobId: job.id,
        eventType: "DRY_RUN_QUEUED",
        eventDataJson: JSON.stringify({ packetVersion: latestPacket.version }),
      },
    });

    await createNotification({
      userId: draft.userId,
      type: "FBR_STATUS",
      title: "Dry run queued",
      message: `Dry run for TY${draft.taxYear} packet v${latestPacket.version} is queued. Open Desktop Agent to run it.`,
      link: `/tax/fbr-connect?draftId=${draft.id}`,
    });

    return {
      success: true,
      job: { id: job.id, jobType: job.jobType, status: job.status },
    };
  } catch (error) {
    console.error("Error queueing dry run:", error);
    return { success: false, error: "Failed to queue dry run job" };
  }
}

export async function queueAssistedFilingJobAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);

    const latestPacket = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
        approvalStatus: "APPROVED",
      },
      orderBy: { version: "desc" },
    });

    if (!latestPacket) {
      return {
        success: false,
        error: "No approved packet. Generate packet first.",
      };
    }

    // Check for existing running job
    const existingRunning = await prisma.localAgentJob.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: {
          in: [
            JOB_STATUSES.CREATED,
            JOB_STATUSES.OFFERED_TO_DEVICE,
            JOB_STATUSES.ACCEPTED_BY_DEVICE,
            JOB_STATUSES.RUNNING,
            JOB_STATUSES.AWAITING_USER_ACTION,
          ],
        },
      },
    });

    if (existingRunning) {
      return {
        success: false,
        error: `Already have a ${existingRunning.jobType} job in ${existingRunning.status} status.`,
      };
    }

    // Dry-run prerequisite removed per client decision (2026-09-05): the
    // pilot moves to real FBR IRIS testing, so assisted filing no longer
    // requires a completed tax_dry_run job first. Field validation now
    // happens live against the portal during the supervised run.

    const job = await prisma.localAgentJob.create({
      data: {
        filingDraftId: draft.id,
        userId: draft.userId,
        jobType: JOB_TYPES.TAX_ASSISTED_FILING,
        status: JOB_STATUSES.CREATED,
        payloadJson: JSON.stringify({
          packetId: latestPacket.id,
          packetVersion: latestPacket.version,
          packetHash: latestPacket.packetHash,
          taxYear: draft.taxYear,
          createdAt: new Date().toISOString(),
          dryRun: false,
          requiresHumanConfirmation: true,
          pausePoints: [
            "password_reset",
            "otp_captcha_pin",
            "payment_psid",
            "final_submit_confirmation",
          ],
          livePilotState: {
            phase: "start",
            confirmations: [],
          },
        }),
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours
      },
    });

    await prisma.fbrConnection.upsert({
      where: { filingDraftId: draft.id },
      update: {
        status: "FILING_QUEUED",
        message: `Assisted filing job queued (packet v${latestPacket.version})`,
        lastHeartbeat: new Date(),
      },
      create: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: "FILING_QUEUED",
        message: `Assisted filing job queued (packet v${latestPacket.version})`,
        startedAt: new Date(),
      },
    });

    await prisma.taxAuditEvent.create({
      data: {
        userId: draft.userId,
        filingDraftId: draft.id,
        jobId: job.id,
        eventType: "ASSISTED_FILING_QUEUED",
        eventDataJson: JSON.stringify({ packetVersion: latestPacket.version }),
      },
    });

    await createNotification({
      userId: draft.userId,
      type: "FBR_STATUS",
      title: "Assisted filing queued",
      message: `Assisted filing for TY${draft.taxYear} is queued. Agent will pause for OTP/PIN/Final Review.`,
      link: `/tax/fbr-connect?draftId=${draft.id}`,
    });

    return {
      success: true,
      job: { id: job.id, jobType: job.jobType, status: job.status },
    };
  } catch (error) {
    console.error("Error queueing assisted filing:", error);
    return { success: false, error: "Failed to queue assisted filing job" };
  }
}

export async function getLocalAgentJobsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const jobs = await prisma.localAgentJob.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        jobType: true,
        status: true,
        pauseAction: true,
        pauseMessage: true,
        errorMessage: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });

    return { success: true, jobs };
  } catch (error) {
    console.error("Error fetching jobs:", error);
    return { success: false, error: "Failed to fetch jobs" };
  }
}

export async function cancelJobAction(jobId: string) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const job = await prisma.localAgentJob.findFirst({
      where: { id: jobId, userId: user.id },
    });

    if (!job) {
      return { success: false, error: "Job not found" };
    }

    if (
      [
        JOB_STATUSES.COMPLETED,
        JOB_STATUSES.FAILED,
        JOB_STATUSES.CANCELLED,
      ].includes(job.status as any)
    ) {
      return { success: false, error: `Job already ${job.status}` };
    }

    const updated = await prisma.localAgentJob.update({
      where: { id: jobId },
      data: { status: JOB_STATUSES.CANCELLED, completedAt: new Date() },
    });

    return { success: true, job: { id: updated.id, status: updated.status } };
  } catch (error) {
    console.error("Error cancelling job:", error);
    return { success: false, error: "Failed to cancel job" };
  }
}

export async function resumeJobAfterPauseAction(
  jobId: string,
  resumeData?: any,
) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const job = await prisma.localAgentJob.findFirst({
      where: { id: jobId, userId: user.id },
    });

    if (!job) {
      return { success: false, error: "Job not found" };
    }

    if (job.status !== JOB_STATUSES.AWAITING_USER_ACTION) {
      return {
        success: false,
        error: `Job not awaiting action, current status: ${job.status}`,
      };
    }

    // Parse existing payload to advance pilot phase
    let payload: any = {};
    try {
      payload = JSON.parse(job.payloadJson || "{}");
    } catch {}

    const currentPhase = payload?.livePilotState?.phase || "start";
    const pauseAction = (job.pauseAction || "").toLowerCase();
    const resultJson = (() => {
      try {
        return JSON.parse(job.resultJson || "{}");
      } catch {
        return {};
      }
    })();
    const requiredAction = (
      resultJson.requiredAction ||
      job.pauseAction ||
      ""
    ).toLowerCase();

    // Final-submit gate: the agent pauses here before pressing Submit in
    // IRIS. A generic resume must never cross it — only the explicit gate
    // choice in the web UI carries finalSubmitConfirmed, so a direct action
    // call or a stale Continue button cannot submit the return.
    const awaitingFinalSubmit =
      requiredAction.includes("final_review") ||
      requiredAction.includes("final_submit") ||
      requiredAction.includes("classic_final");
    if (awaitingFinalSubmit && resumeData?.finalSubmitConfirmed !== true) {
      return {
        success: false,
        error:
          "This return is at the final submit gate. Choose Submit to FBR or Not now on the filing screen.",
      };
    }

    const nextPhase = getNextFbrPilotPhase(
      requiredAction || pauseAction,
      currentPhase,
    );

    const existingConfirmations = Array.isArray(
      payload?.livePilotState?.confirmations,
    )
      ? payload.livePilotState.confirmations
      : [];
    const updatedPayload = {
      ...payload,
      livePilotState: {
        phase: nextPhase,
        confirmations: [
          ...existingConfirmations,
          {
            action: requiredAction || pauseAction,
            confirmedAt: new Date().toISOString(),
            confirmedByUserId: user.id,
          },
        ],
      },
    };

    const updated = await prisma.localAgentJob.update({
      where: { id: jobId },
      data: {
        status: JOB_STATUSES.OFFERED_TO_DEVICE, // offer again so device picks it up
        payloadJson: JSON.stringify(updatedPayload),
        resumeDataJson: resumeData ? JSON.stringify(resumeData) : null,
        pauseAction: null,
        pauseMessage: null,
        resultJson: null,
        startedAt: null, // reset so it will be picked again
      },
    });

    await prisma.taxAuditEvent.create({
      data: {
        userId: user.id,
        filingDraftId: job.filingDraftId,
        jobId: job.id,
        eventType: "JOB_RESUMED_BY_USER",
        eventDataJson: JSON.stringify({
          previousPause: job.pauseAction,
          nextPhase,
        }),
      },
    });

    return { success: true, job: { id: updated.id, status: updated.status } };
  } catch (error) {
    console.error("Error resuming job:", error);
    return { success: false, error: "Failed to resume job" };
  }
}

export async function getTrustedDevicesAction(draftId?: string) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const devices = await prisma.trustedDevice.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: "desc" },
      take: 5,
      select: {
        id: true,
        deviceName: true,
        partitionKey: true,
        status: true,
        localFbrConnectedAt: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    return { success: true, devices };
  } catch (error) {
    console.error("Error fetching devices:", error);
    return { success: false, error: "Failed to fetch devices" };
  }
}
