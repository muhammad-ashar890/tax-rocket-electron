"use server";

import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  AVATAR_FILE_EXTENSIONS,
  AVATAR_MIME_TYPES,
  detectImageSignature,
  sanitizeDownloadFileName,
} from "@/lib/safe-file-types";
import { parseTaxpayerDateOfBirth } from "@/lib/tax/taxpayer-age";
import {
  formatCnicNumber,
  normalizeIdentityName,
} from "@/lib/tax/cnic-profile";
import { isSupportedTaxYear } from "@/lib/tax/tax-year-period";

export async function getUserProfile() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return { success: false };

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) return { success: false };

    return {
      success: true,
      user: {
        fullName: user.name || "",
        email: user.email || "",
        image: user.image || "",
        cnic: user.cnic ? formatCnicNumber(user.cnic) : "",
        ntn: user.ntn || "",
        phone: user.phone || "",
        address: user.address || "",
        city: user.city || "",
        dateOfBirth: user.dateOfBirth
          ? user.dateOfBirth.toISOString().split("T")[0]
          : "",
        taxYear: user.defaultTaxYear
          ? user.defaultTaxYear.toString()
          : new Date().getFullYear().toString(),
      },
    };
  } catch (error) {
    console.error("Error fetching profile:", error);
    return { success: false, error: "Failed to fetch profile" };
  }
}

export async function uploadUserAvatarAction(formData: FormData) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;

    if (!email) return { success: false, error: "Unauthorized" };

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return { success: false, error: "Profile image is required" };
    }

    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      return {
        success: false,
        error: "Profile image must be smaller than 5 MB",
      };
    }

    // A prefix test such as `file.type.startsWith("image/")` accepts
    // "image/svg+xml". An SVG is an XML document that may contain a <script>
    // element, and serving one back from our own origin would let it read the
    // signed-in session. Only the three bitmap formats below are accepted.
    const declaredMimeType = file.type.trim().toLowerCase();
    const extension = path.extname(file.name).toLowerCase();

    if (!AVATAR_MIME_TYPES.has(declaredMimeType)) {
      return {
        success: false,
        error: "Profile image must be a JPEG, PNG or WebP file",
      };
    }

    if (!AVATAR_FILE_EXTENSIONS.has(extension)) {
      return {
        success: false,
        error: "Profile image must end in .jpg, .jpeg, .png or .webp",
      };
    }

    // The declared type and the extension are both client-controlled, so the
    // leading bytes decide what this file actually is.
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const detectedMimeType = detectImageSignature(fileBytes);

    if (!detectedMimeType || !AVATAR_MIME_TYPES.has(detectedMimeType)) {
      return {
        success: false,
        error: "Profile image is not a valid JPEG, PNG or WebP image",
      };
    }

    if (detectedMimeType !== declaredMimeType) {
      return {
        success: false,
        error: "Profile image contents do not match its file type",
      };
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) return { success: false, error: "User profile not found" };

    const uploadDirectory = path.join(process.cwd(), "uploads", "profile");
    await mkdir(uploadDirectory, { recursive: true });

    // The stored name is derived from the verified signature, never from the
    // name the client supplied.
    const storedExtension =
      detectedMimeType === "image/jpeg"
        ? ".jpg"
        : detectedMimeType === "image/png"
          ? ".png"
          : ".webp";
    const storedFileName = `${randomUUID()}${storedExtension}`;
    const relativeFilePath = path.join("profile", storedFileName);

    await writeFile(
      path.join(process.cwd(), "uploads", relativeFilePath),
      fileBytes,
    );

    const avatarDocument = await prisma.document.create({
      data: {
        userId: user.id,
        documentType: "PROFILE_AVATAR",
        fileName: sanitizeDownloadFileName(file.name),
        fileUrl: relativeFilePath,
        // The verified signature is stored, not the client's claim.
        mimeType: detectedMimeType,
        sizeBytes: file.size,
        extractionStatus: "NOT_APPLICABLE",
      },
      select: { id: true },
    });

    const avatarUrl = `/api/documents/${avatarDocument.id}`;
    await prisma.user.update({
      where: { id: user.id },
      data: { image: avatarUrl },
    });

    revalidatePath("/tax/profile");
    return { success: true, avatarUrl };
  } catch (error) {
    console.error("Error uploading user avatar:", error);
    return { success: false, error: "Failed to upload profile image" };
  }
}

export async function removeUserAvatarAction() {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;

    if (!email) return { success: false, error: "Unauthorized" };

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, image: true },
    });

    if (!user) return { success: false, error: "User profile not found" };

    if (user.image?.startsWith("/api/documents/")) {
      const documentId = user.image.split("/").pop();
      if (documentId) {
        const avatarDocument = await prisma.document.findFirst({
          where: {
            id: documentId,
            userId: user.id,
            documentType: "PROFILE_AVATAR",
          },
          select: { id: true, fileUrl: true },
        });

        if (avatarDocument) {
          const relativePath = path.normalize(avatarDocument.fileUrl);
          if (
            !path.isAbsolute(relativePath) &&
            !relativePath.startsWith("..")
          ) {
            await unlink(
              path.join(process.cwd(), "uploads", relativePath),
            ).catch(() => undefined);
          }
          await prisma.document.delete({ where: { id: avatarDocument.id } });
        }
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { image: null },
    });

    revalidatePath("/tax/profile");
    revalidatePath("/tax/dashboard");
    return { success: true };
  } catch (error) {
    console.error("Error removing user avatar:", error);
    return { success: false, error: "Failed to remove profile image" };
  }
}

export async function updateUserProfile(data: {
  fullName: string;
  cnic: string;
  ntn: string;
  dateOfBirth: string;
  phone: string;
  address: string;
  city: string;
  taxYear: string;
}) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return { success: false, error: "Unauthorized" };

    const normalizedName = normalizeIdentityName(data.fullName);
    if (!normalizedName || !/\p{L}/u.test(normalizedName)) {
      return { success: false, error: "Enter a valid name using letters only" };
    }

    const normalizedCnic = data.cnic ? formatCnicNumber(data.cnic) : "";
    if (data.cnic && !/^\d{5}-\d{7}-\d$/.test(normalizedCnic)) {
      return {
        success: false,
        error: "Enter a valid 13-digit CNIC in XXXXX-XXXXXXX-X format",
      };
    }

    const dob = data.dateOfBirth
      ? parseTaxpayerDateOfBirth(data.dateOfBirth)
      : null;
    if (data.dateOfBirth && !dob) {
      return {
        success: false,
        error: "Enter a valid date of birth",
      };
    }

    const taxYear = data.taxYear ? parseInt(data.taxYear, 10) : null;

    if (taxYear !== null && !isSupportedTaxYear(taxYear)) {
      return {
        success: false,
        error: "Only Tax Year 2026 is currently supported",
      };
    }

    await prisma.user.update({
      where: { email: session.user.email },
      data: {
        name: normalizedName,
        cnic: normalizedCnic || null,
        ntn: data.ntn || null,
        phone: data.phone || null,
        dateOfBirth: dob,
        address: data.address || null,
        city: data.city || null,
        defaultTaxYear: taxYear,
      },
    });

    revalidatePath("/tax/profile");
    revalidatePath("/tax/dashboard");
    revalidatePath("/tax/settings");
    revalidatePath("/tax/new");
    return { success: true };
  } catch (error) {
    console.error("Error updating profile:", error);
    return {
      success: false,
      error: "Failed to update profile. Make sure CNIC/NTN are unique.",
    };
  }
}
