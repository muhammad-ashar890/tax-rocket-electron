import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tax/fbr-desktop";

/**
 * POST /api/fbr-connect/desktop/register
 * Electron agent calls this to register as trusted device
 * Body: { launchToken, deviceName, safeStorageTokenHash?, platform, version }
 *
 * This endpoint is called by Electron, not by NextAuth session - uses launchToken
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}) as any);
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const launchToken = (body as any)?.launchToken || bearerToken;
    const { deviceName, platform, version, ipAddress } = body as any;

    if (!launchToken) {
      return NextResponse.json(
        { success: false, error: "launchToken required (body or Bearer)" },
        { status: 400 },
      );
    }

    const deviceTokenHash = hashToken(launchToken);

    // Find pending device by hash
    const device = await prisma.trustedDevice.findUnique({
      where: { deviceTokenHash },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!device) {
      return NextResponse.json(
        { success: false, error: "Invalid launch token" },
        { status: 401 },
      );
    }

    // Check if expired (10 min window for PENDING, but allow ACTIVE to re-register)
    if (device.status === "PENDING") {
      const createdAt = device.createdAt.getTime();
      const now = Date.now();
      const tenMinutes = 10 * 60 * 1000;
      if (now - createdAt > tenMinutes) {
        // Expire it
        await prisma.trustedDevice.update({
          where: { id: device.id },
          data: { status: "EXPIRED" },
        });
        return NextResponse.json(
          {
            success: false,
            error: "Launch token expired. Create new session.",
          },
          { status: 401 },
        );
      }
    }

    if (device.status === "REVOKED" || device.status === "EXPIRED") {
      return NextResponse.json(
        { success: false, error: `Device ${device.status.toLowerCase()}` },
        { status: 401 },
      );
    }

    // Update device to ACTIVE
    const updatedDevice = await prisma.trustedDevice.update({
      where: { id: device.id },
      data: {
        status: "ACTIVE",
        deviceName: deviceName || device.deviceName,
        lastSeenAt: new Date(),
        ipAddress: ipAddress || req.ip || null,
        userAgent: req.headers.get("user-agent") || null,
      },
    });

    // Create audit event
    await prisma.taxAuditEvent.create({
      data: {
        userId: device.userId,
        deviceId: device.id,
        eventType: "DEVICE_REGISTERED",
        eventDataJson: JSON.stringify({
          platform,
          version,
          partitionKey: device.partitionKey,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      ok: true, // compat with old Electron which checks result.ok
      deviceAuthToken: launchToken,
      partitionKey: updatedDevice.partitionKey,
      trustedDevice: {
        publicId: updatedDevice.id,
        id: updatedDevice.id,
        partitionKey: updatedDevice.partitionKey,
      },
      device: {
        id: updatedDevice.id,
        partitionKey: updatedDevice.partitionKey,
        deviceName: updatedDevice.deviceName,
        status: updatedDevice.status,
        userId: updatedDevice.userId,
      },
      // This token (hashed launchToken) will be used for subsequent polling
      auth: {
        deviceToken: launchToken, // Electron should store this securely via safeStorage
        partitionKey: updatedDevice.partitionKey,
      },
      config: {
        pollingIntervalMs: 3000,
        jobEndpoints: {
          next: "/api/local-agent/jobs/next",
          context: "/api/local-agent/jobs/{jobId}/context",
          status: "/api/local-agent/jobs/{jobId}/status",
        },
        fbrEndpoints: {
          ready: "/api/fbr-connect/desktop/ready",
        },
      },
    });
  } catch (error) {
    console.error("Error registering device:", error);
    return NextResponse.json(
      { success: false, error: "Failed to register device" },
      { status: 500 },
    );
  }
}
