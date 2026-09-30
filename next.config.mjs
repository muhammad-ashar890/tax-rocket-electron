/** @type {import('next').NextConfig} */

/**
 * Baseline security headers for every response.
 *
 * These are deliberately set at the framework level rather than per route so
 * that a page added later inherits them without anyone having to remember.
 */
const securityHeaders = [
  // Stops a browser from second-guessing a declared content type. Without it
  // a stored upload can be re-interpreted as HTML and run as same-origin.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // The application has no framed surface, so framing is refused outright to
  // remove clickjacking against the filing and approval flows.
  { key: "X-Frame-Options", value: "DENY" },
  // Keeps draft identifiers and filing paths out of third-party referer logs.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No page here needs a camera, microphone or location.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Cross-origin isolation for the tab itself.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/**
 * Content Security Policy.
 *
 * Next.js injects inline bootstrap scripts and styled-jsx style tags, so
 * 'unsafe-inline' is required for script-src and style-src to work without a
 * per-request nonce. In development the dev overlay and fast refresh also
 * need 'unsafe-eval' and a websocket connection.
 *
 * The directives that actually contain the avatar/document threat are
 * object-src, frame-ancestors, base-uri and form-action, none of which need
 * any relaxation.
 */
const isDevelopment = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // data: covers inline icons; blob: covers client-side previews.
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self' data:",
  isDevelopment ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
  // No plug-in content: this is what neutralises a hostile stored object.
  "object-src 'none'",
  // Nothing may frame this application.
  "frame-ancestors 'none'",
  // A stored document cannot rewrite relative URL resolution.
  "base-uri 'self'",
  // Forms may only post back to this origin.
  "form-action 'self'",
].join("; ");

const nextConfig = {
  // Do not advertise the framework version to scanners.
  poweredByHeader: false,

  experimental: {
    serverComponentsExternalPackages: ["pdfkit"],
    // Tax documents can be up to 10 MB; keep a small margin above the
    // application-level upload limit in app/actions/documents.ts.
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },

  async headers() {
    return [
      {
        // Applies to every route, including the file-serving API routes,
        // which layer their own stricter policy on top.
        source: "/:path*",
        headers: [
          ...securityHeaders,
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ],
      },
    ];
  },
};

export default nextConfig;
