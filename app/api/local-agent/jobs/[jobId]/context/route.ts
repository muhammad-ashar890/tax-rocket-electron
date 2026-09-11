import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tax/fbr-desktop";
import {
  getFbrPortalAutomationConfig,
  DEFAULT_SELECTOR_BUNDLE,
  getCombinedAgentConfig,
  resolveIrisRouteFamily,
} from "@/lib/tax/fbr-agent-config";
import { flattenPortalFieldMap } from "@/lib/tax/portal-field-map";

/**
 * GET /api/local-agent/jobs/[jobId]/context
 * Electron agent fetches filing packet context including portalFieldMap
 * Query: ?deviceToken=xxx
 *
 * Returns snapshot with portalFieldMap for IRIS filling
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const { searchParams } = new URL(req.url);
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const deviceToken =
      searchParams.get("deviceToken") ||
      req.headers.get("x-device-token") ||
      bearerToken;

    if (!deviceToken) {
      return NextResponse.json(
        {
          success: false,
          ok: false,
          error: "deviceToken required (query, x-device-token or Bearer)",
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

    const job = await prisma.localAgentJob.findFirst({
      where: {
        id: jobId,
        OR: [
          { trustedDeviceId: device.id },
          { trustedDeviceId: null, userId: device.userId }, // Allow unassigned job fetch if same user
        ],
      },
      include: {
        filingDraft: {
          select: {
            id: true,
            taxYear: true,
            filerType: true,
            taxpayerListStatus: true,
          },
        },
      },
    });

    if (!job) {
      return NextResponse.json(
        { success: false, error: "Job not found" },
        { status: 404 },
      );
    }

    let payload: any = {};
    try {
      payload = JSON.parse(job.payloadJson || "{}");
    } catch {}
    if (
      !payload.packetId ||
      !Number.isInteger(payload.packetVersion) ||
      !payload.packetHash
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Job has no pinned approved packet. Create a new job.",
        },
        { status: 409 },
      );
    }
    // Never switch to a newer/unapproved packet after the user queued a job.
    const packet = await prisma.filingPacket.findFirst({
      where: {
        id: payload.packetId,
        version: payload.packetVersion,
        packetHash: payload.packetHash,
        filingDraftId: job.filingDraftId,
        userId: device.userId,
        approvalStatus: "APPROVED",
        status: { not: "SUPERSEDED" },
      },
    });

    if (!packet) {
      return NextResponse.json(
        {
          success: false,
          error:
            "The queued approved packet is unavailable or superseded. Create a new job from an approved packet.",
        },
        { status: 404 },
      );
    }

    let snapshot: any = {};
    try {
      snapshot = JSON.parse(packet.snapshotJson);
    } catch (e) {
      console.error("Failed to parse snapshotJson", e);
      return NextResponse.json(
        { success: false, error: "Invalid packet snapshot" },
        { status: 500 },
      );
    }

    // Mark job as accepted/running
    if (job.status === "created" || job.status === "offered_to_device") {
      await prisma.localAgentJob.update({
        where: { id: job.id },
        data: {
          trustedDeviceId: device.id,
          status: "accepted_by_device",
          startedAt: new Date(),
        },
      });
    }

    await prisma.taxAuditEvent.create({
      data: {
        userId: device.userId,
        filingDraftId: job.filingDraftId,
        jobId: job.id,
        deviceId: device.id,
        eventType: "JOB_CONTEXT_FETCHED",
        eventDataJson: JSON.stringify({
          packetVersion: packet.version,
          jobType: job.jobType,
        }),
      },
    });

    // Get selector bundle for agent (merged old + new)
    const routeFamily = resolveIrisRouteFamily(
      snapshot.routeMetadata?.routeFamily || snapshot.routeFamily,
    );
    const portalConfig = await getFbrPortalAutomationConfig({ routeFamily });
    const combinedConfig = getCombinedAgentConfig();

    // The approved packet's verified field map is the only map sent to the
    // production agent. It is never replaced with synthetic portal fields.
    const rawPortalFieldMap = snapshot.portalFieldMap || {};
    const portalMapDetailed =
      snapshot.portalFieldMapDetailed ||
      (Array.isArray(rawPortalFieldMap) ? null : rawPortalFieldMap);
    const normalizedRealPortalFieldMap = Array.isArray(rawPortalFieldMap)
      ? rawPortalFieldMap
      : flattenPortalFieldMap(rawPortalFieldMap);

    const selectedMap = normalizedRealPortalFieldMap;
    const taxYear = Number(snapshot.filing?.taxYear || job.filingDraft.taxYear);
    const finalSnapshot = {
      ...snapshot,
      taxYear,
      routeMetadata: {
        ...(snapshot.routeMetadata || {}),
        routeFamily,
        requiresIdentification: !routeFamily,
      },
      portalFieldMap: selectedMap,
      portalFieldMapDetailed: portalMapDetailed,
    };

    return NextResponse.json({
      success: true,
      ok: true,
      // Electron reads job.payload.livePilotState to decide the next
      // assisted-filing pause. Without this, every Resume restarts at
      // password_reset.
      payload,
      livePilotState: payload?.livePilotState ?? {
        phase: "start",
        confirmations: [],
      },
      job: {
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        filingDraftId: job.filingDraftId,
        payload,
      },
      packet: {
        id: packet.id,
        version: packet.version,
        packetHash: packet.packetHash,
        taxYear,
        filerType: snapshot.filing?.filerType,
        taxpayerListStatus: snapshot.filing?.taxpayerListStatus,
        snapshot: finalSnapshot, // for old Electron that expects packet.snapshot
      },
      filingPacket: {
        id: packet.id,
        version: packet.version,
        packetVersion: packet.version,
        taxYear,
        packetHash: packet.packetHash,
        snapshot: finalSnapshot,
      },
      taxAutomationConfig: portalConfig,
      automationConfig: portalConfig,
      // This is the critical data for Electron agent
      snapshot: finalSnapshot,
      // Also provide flat map at top level for some old workers
      portalFieldMap: selectedMap,
      // Selector bundle for IRIS automation (can be updated without deploy)
      selectors: {
        version: portalConfig.selectorBundle.bundleVersion,
        bundleId: portalConfig.selectorBundle.bundleId,
        bundle: DEFAULT_SELECTOR_BUNDLE,
        combined: combinedConfig,
        routeSelector: portalConfig.routeSelector,
      },
      // Automation config for agent (from merged fbr-agent-config.ts)
      automation: portalConfig,
      // Env config for agent
      config: {
        irisLoginUrl: portalConfig.readiness.loginUrl,
        irisReadySelector: portalConfig.readiness.readySelector,
        dryRunUrl: portalConfig.dryRun.entryUrl,
        reviewGateSelector: portalConfig.dryRun.reviewGateSelector,
        finalSubmitSelector: portalConfig.dryRun.finalSubmitSelector,
        useMockIris: false,
      },
    });
  } catch (error) {
    console.error("Error fetching job context:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch context" },
      { status: 500 },
    );
  }
}
