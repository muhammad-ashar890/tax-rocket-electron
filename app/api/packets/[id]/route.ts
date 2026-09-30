
import { readFile } from "fs/promises";
import path from "path";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = Readonly<{
  params: {
    id: string;
  };
}>;

export async function GET(_request: Request, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User profile not found" }, { status: 404 });
  }

  const packet = await prisma.filingPacket.findFirst({
    where: {
      id: params.id,
      userId: user.id,
    },
    select: {
      fileUrl: true,
      version: true,
    },
  });

  if (!packet?.fileUrl) {
    return NextResponse.json({ error: "Packet PDF not found" }, { status: 404 });
  }

  const relativePath = path.normalize(packet.fileUrl);
  if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return NextResponse.json({ error: "Invalid packet path" }, { status: 400 });
  }

  try {
    const filePath = path.join(process.cwd(), "uploads", relativePath);
    const file = await readFile(filePath);

    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename="TaxRocket-Filing-Packet-v${packet.version}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return NextResponse.json({ error: "Stored packet PDF not found" }, { status: 404 });
  }
}
