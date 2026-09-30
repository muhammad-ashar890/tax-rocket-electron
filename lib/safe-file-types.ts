/**
 * Central allow-lists for every file this application accepts or serves back.
 *
 * A browser will execute script inside an SVG, an XHTML document or an HTML
 * file when that file is served inline from our own origin, so a stored file
 * is only ever returned with a content type taken from these tables. The
 * `mimeType` a client supplied at upload time is treated as an untrusted hint
 * and is never echoed back in a response header.
 */

export type SafeFileKind = "avatar" | "document";

/** Content types an avatar may be stored and re-served as. */
export const AVATAR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** File extensions that may accompany an avatar upload. */
export const AVATAR_FILE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);

/** Content types a tax document may be stored and re-served as. */
export const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

/**
 * Maps a stored content type to the exact value we are willing to put in a
 * response header. Anything absent from the table is served as an opaque
 * binary download so that the browser never renders it as active content.
 */
const SERVABLE_MIME_TYPES = new Set([
  ...AVATAR_MIME_TYPES,
  ...DOCUMENT_MIME_TYPES,
]);

/** Content type used whenever a stored value is not on the allow-list. */
export const FALLBACK_BINARY_MIME_TYPE = "application/octet-stream";

/**
 * Returns the content type that may safely be echoed into a response header.
 * Unknown types collapse to an opaque binary type rather than being trusted.
 */
export function resolveServableMimeType(storedMimeType: string | null): string {
  const normalized = (storedMimeType ?? "").trim().toLowerCase();
  return SERVABLE_MIME_TYPES.has(normalized)
    ? normalized
    : FALLBACK_BINARY_MIME_TYPE;
}

/**
 * Only bitmap images are ever rendered inline. A PDF is downloaded instead:
 * a PDF can carry JavaScript, and browsers hand it to a plug-in that has been
 * a recurring source of same-origin issues.
 */
export function isInlineRenderableMimeType(mimeType: string): boolean {
  return (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp"
  );
}

/**
 * Verifies the leading bytes of an upload against its claimed content type.
 *
 * A client controls both the `type` field and the file extension, so neither
 * proves anything on its own: an SVG renamed to `.png` and sent as
 * `image/png` passes every string comparison. The signatures below are the
 * fixed byte prefixes each real format must begin with.
 */
export function detectImageSignature(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length >= pngSignature.length &&
    pngSignature.every((byte, index) => bytes[index] === byte)
  ) {
    return "image/png";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  // PDF: "%PDF-"
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }

  return null;
}

/**
 * Strips characters that would let a file name break out of a
 * `Content-Disposition` header or suggest a different type to the browser.
 */
export function sanitizeDownloadFileName(fileName: string): string {
  const withoutPath = fileName.split(/[\\/]/).pop() ?? "file";
  const cleaned = withoutPath
    .replace(/[\r\n"]/g, "_")
    // Keep the character set narrow: anything exotic is replaced rather than
    // escaped, which avoids relying on correct quoting further downstream.
    .replace(/[^\w.\- ]/g, "_")
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file";
}
