import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tax/fbr-desktop";

/**
 * POST /api/fbr-connect/desktop/ready
 * Electron agent marks that user has logged into IRIS locally and agent is ready
 * Body: { deviceToken, filingDraftId? }
 *
 * Updates trustedDevice.localFbrConnectedAt and fbrConnection status
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
        { success: false, error: "Invalid or inactive device" },
        { status: 401 },
      );
    }

    // Update device ready timestamp
    const updatedDevice = await prisma.trustedDevice.update({
      where: { id: device.id },
      data: {
        localFbrConnectedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    // If filingDraftId provided, update its FbrConnection
    if (filingDraftId) {
      const draft = await prisma.filingDraft.findFirst({
        where: { id: filingDraftId, userId: device.userId },
      });

      if (draft) {
        await prisma.fbrConnection.upsert({
          where: { filingDraftId: draft.id },
          update: {
            status: "AGENT_CONNECTED",
            agentId: device.id,
            partitionKey: device.partitionKey,
            deviceId: device.id,
            message: `Trusted Desktop Agent connected (partition: ${device.partitionKey})`,
            lastHeartbeat: new Date(),
          },
          create: {
            filingDraftId: draft.id,
            userId: device.userId,
            status: "AGENT_CONNECTED",
            agentId: device.id,
            partitionKey: device.partitionKey,
            deviceId: device.id,
            message: `Trusted Desktop Agent connected`,
            startedAt: new Date(),
          },
        });
      }
    } else {
      // Update all waiting connections for this user
      await prisma.fbrConnection.updateMany({
        where: {
          userId: device.userId,
          status: { in: ["WAITING_FOR_AGENT", "NOT_STARTED"] },
        },
        data: {
          status: "AGENT_CONNECTED",
          agentId: device.id,
          partitionKey: device.partitionKey,
          deviceId: device.id,
          message: `Trusted Desktop Agent connected`,
          lastHeartbeat: new Date(),
        },
      });
    }

    await prisma.taxAuditEvent.create({
      data: {
        userId: device.userId,
        filingDraftId: filingDraftId || null,
        deviceId: device.id,
        eventType: "DEVICE_READY",
        eventDataJson: JSON.stringify({
          partitionKey: device.partitionKey,
          filingDraftId,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      ok: true,
      device: {
        id: updatedDevice.id,
        partitionKey: updatedDevice.partitionKey,
        localFbrConnectedAt: updatedDevice.localFbrConnectedAt?.toISOString(),
        status: updatedDevice.status,
      },
    });
  } catch (error) {
    console.error("Error marking device ready:", error);
    return NextResponse.json(
      { success: false, error: "Failed to mark ready" },
      { status: 500 },
    );
  }
}
