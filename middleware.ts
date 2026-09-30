import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

/**
 * Edge guard for every authenticated surface.
 *
 * Three of the pages under /tax are client components ("use client"), so they
 * cannot call getServerSession themselves. Before this middleware existed
 * /tax/new, /tax/profile and /tax/settings rendered for anonymous visitors:
 * no data leaked, because every server action and file route checks the
 * session independently, but the visitor filled in a form and then met an
 * "Unauthorized" error on submit.
 *
 * Guarding by path prefix here means a page added under /tax later is covered
 * without anyone having to remember to add a check.
 */
export default withAuth(
  function middleware() {
    return NextResponse.next();
  },
  {
    callbacks: {
      // A JWT session strategy is in use, so the presence of a decoded token
      // is the authentication signal.
      authorized: ({ token }) => Boolean(token),
    },
    pages: {
      // Keep this aligned with `pages.signIn` in lib/auth.ts. NextAuth appends
      // ?callbackUrl=... so the visitor returns to the page they wanted.
      signIn: "/login",
    },
  },
);

export const config = {
  /**
   * Everything under /tax requires a session.
   *
   * Deliberately excluded:
   *   /                    marketing page
   *   /login, /signup      the way in
   *   /api/auth/*          NextAuth's own endpoints, which must stay open
   *   /api/documents/*     already enforce session plus row ownership, and
   *   /api/packets/*       must answer 401 as JSON rather than redirect to
   *                        an HTML login page
   */
  matcher: ["/tax/:path*"],
};
