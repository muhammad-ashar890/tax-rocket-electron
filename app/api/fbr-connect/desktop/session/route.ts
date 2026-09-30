import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  generateLaunchToken,
  generatePartitionKey,
  hashToken,
  buildDesktopSessionConfig,
  chooseDesktopAccountReference,
} from "@/lib/tax/fbr-desktop";

/**
 * POST /api/fbr-connect/desktop/session
 * Creates a short-lived launch token for Electron desktop agent
 * Body: { filingDraftId }
 *
 * Returns: { launchToken, partitionKey, deepLink, localhostUrl, expiresAt }
 *
 * Flow from worker.md:
 * 1. User approves packet in web app
 * 2. Frontend calls this endpoint to get launch token
 * 3. Frontend triggers taxrocket-connect:// deep link or localhost bridge
 * 4. Electron app registers via /register
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, cnic: true, ntn: true },
    });
    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const body = await req.json();
    const { filingDraftId } = body;

    if (!filingDraftId) {
      return NextResponse.json(
        { success: false, error: "filingDraftId required" },
        { status: 400 },
      );
    }

    // Verify draft ownership and that packet exists
    const draft = await prisma.filingDraft.findFirst({
      where: { id: filingDraftId, userId: user.id },
      select: { id: true, taxYear: true, status: true, filerType: true },
    });

    if (!draft) {
      return NextResponse.json(
        { success: false, error: "Filing draft not found" },
        { status: 404 },
      );
    }

    const latestPacket = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: user.id,
        status: { not: "SUPERSEDED" },
        approvalStatus: "APPROVED",
      },
      orderBy: { version: "desc" },
    });

    if (!latestPacket) {
      return NextResponse.json(
        {
          success: false,
          error: "No approved packet found. Generate packet first.",
        },
        { status: 400 },
      );
    }

    // Generate launch token and partition key
    const launchToken = generateLaunchToken();
    const partitionKey = generatePartitionKey(user.id);
    const deviceTokenHash = hashToken(launchToken);

    const accountReference = chooseDesktopAccountReference({
      filerType: draft.filerType,
      cnic: user.cnic,
      ntn: user.ntn,
    });

    const config = buildDesktopSessionConfig({
      launchToken,
      partitionKey,
      deviceTokenHash,
      accountReference,
    });

    // The partition key is STABLE per user (the Electron profile holds the
    // IRIS login), and partitionKey is UNIQUE in the DB. Reconnecting must
    // therefore REUSE this user's device row instead of creating a second
    // one — a plain create throws P2002 here and surfaces in the UI as
    // "Failed to create desktop session".
    const existingDevice = await prisma.trustedDevice.findUnique({
      where: { partitionKey },
    });

    if (existingDevice && existingDevice.userId !== user.id) {
      return NextResponse.json(
        { success: false, error: "Device partition ownership mismatch" },
        { status: 409 },
      );
    }
    const device = await prisma.trustedDevice.upsert({
      where: { partitionKey },
      update: {
        deviceTokenHash,
        status: "PENDING",
        createdAt: new Date(), // existing register endpoint's 10-minute launch clock
        localFbrConnectedAt: null, // do not inherit an old ready timestamp
        lastSeenAt: new Date(),
      },
      create: {
        userId: user.id,
        deviceName: `Desktop-${new Date().toISOString().slice(0, 10)}`,
        deviceTokenHash,
        partitionKey,
        status: "PENDING",
        lastSeenAt: new Date(),
      },
    });

    // Audit event
    await prisma.taxAuditEvent.create({
      data: {
        userId: user.id,
        filingDraftId: draft.id,
        deviceId: device.id,
        eventType: "DESKTOP_SESSION_CREATED",
        eventDataJson: JSON.stringify({
          partitionKey,
          packetVersion: latestPacket.version,
          expiresAt: config.expiresAt,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      session: config,
      device: {
        id: device.id,
        partitionKey: device.partitionKey,
        status: device.status,
      },
      packet: {
        id: latestPacket.id,
        version: latestPacket.version,
        taxYear: draft.taxYear,
      },
    });
  } catch (error) {
    console.error("Error creating desktop session:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create desktop session" },
      { status: 500 },
    );
  }
}
