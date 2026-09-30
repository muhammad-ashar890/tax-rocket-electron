
import { readFile } from "fs/promises";
import path from "path";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isInlineRenderableMimeType,
  resolveServableMimeType,
  sanitizeDownloadFileName,
} from "@/lib/safe-file-types";

type RouteContext = {
  params: {
    id: string;
  };
};

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

  const document = await prisma.document.findFirst({
    where: {
      id: params.id,
      userId: user.id,
    },
  });

  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const relativePath = path.normalize(document.fileUrl);
  if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return NextResponse.json({ error: "Invalid document path" }, { status: 400 });
  }

  try {
    const filePath = path.join(process.cwd(), "uploads", relativePath);
    const file = await readFile(filePath);
    const safeDownloadName = sanitizeDownloadFileName(document.fileName);

    // The stored mime type originated from a client upload, so it is mapped
    // through an allow-list before it reaches a response header. Anything
    // unrecognised is served as an opaque download.
    const contentType = resolveServableMimeType(document.mimeType);

    // Only bitmap images render inline. Everything else is forced to download
    // so the browser never treats a stored file as active same-origin content.
    const disposition = isInlineRenderableMimeType(contentType)
      ? "inline"
      : "attachment";

    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `${disposition}; filename="${safeDownloadName}"`,
        "Cache-Control": "private, no-store",
        // Stops the browser from ignoring the declared type and sniffing the
        // body as HTML or SVG.
        "X-Content-Type-Options": "nosniff",
        // A stored file must never become a same-origin script or frame.
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    return NextResponse.json({ error: "Stored file not found" }, { status: 404 });
  }
}
