"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Home, Link2, Settings, User, X } from "lucide-react";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";

// Mirrors DashboardSidebar's primaryLinks exactly — same routes, same
// icons, same order — so the mobile drawer and the desktop sidebar
// always show identical navigation.
const NAV_LINKS = [
  { href: "/tax/dashboard", label: "Home", icon: Home },
  { href: "/tax/new", label: "New Filing", icon: FileText },
  { href: "/tax/history", label: "History", icon: FileText },
  { href: "/tax/fbr-connect", label: "FBR Connect", icon: Link2 },
  { href: "/tax/profile", label: "Profile", icon: User },
  { href: "/tax/settings", label: "Settings", icon: Settings },
];

type MobileNavDrawerProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * MobileNavDrawer — left-side slide-in panel, mobile/tablet only (the
 * hamburger trigger in SiteHeader is `lg:hidden`).
 *
 * v4 fix: previously this component was returned directly inside
 * <SiteHeader>'s JSX, making it a DOM descendant of <header>. Because
 * the header has `backdrop-blur` (backdrop-filter) plus `sticky` +
 * `z-40`, it becomes the *containing block* for any `position: fixed`
 * descendant in most browsers — so our "fixed inset-0" overlay was
 * being sized relative to the header's own box (~64px tall) instead of
 * the full viewport. That's exactly why the dark overlay only ever
 * covered the header strip instead of the whole page.
 *
 * Fix: render this drawer through a React Portal straight into
 * `document.body`, so it's a sibling of <header> in the real DOM tree
 * rather than a descendant. That makes it immune to any ancestor's
 * backdrop-filter/transform/stacking quirks — `fixed inset-0` now
 * always means the full viewport, guaranteed.
 *
 * Also fixes: the logo inside the drawer is now a working link back to
 * the dashboard (previously just a static image/wordmark).
 */
export function MobileNavDrawer({ open, onClose }: MobileNavDrawerProps) {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const rowCls = (active: boolean) =>
    `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
      active
        ? "bg-[#376952] text-white shadow-sm"
        : "text-gray-700 hover:bg-gray-50"
    }`;

  const drawer = (
    <div
      className="fixed inset-0 lg:hidden"
      style={{ zIndex: 100, pointerEvents: open ? "auto" : "none" }}
      aria-hidden={!open}
    >
      {/* Backdrop — now a direct child of <body> via the portal, so
          inset-0 correctly spans the entire viewport. */}
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
        style={{ opacity: open ? 1 : 0, transition: "opacity 250ms ease" }}
      />

      {/* Panel — explicit 100vh so it always reaches the bottom of the
          screen regardless of how little content is inside it. */}
      <div
        className="absolute left-0 top-0 flex w-72 max-w-[82vw] flex-col overflow-hidden bg-white shadow-2xl"
        style={{
          height: "100vh",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 280ms ease-out",
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3.5">
          <Link
            href="/tax/dashboard"
            onClick={onClose}
            className="flex items-center gap-2"
          >
            <TaxRocketLogo />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
          {NAV_LINKS.map((link) => {
            const Icon = link.icon;
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={onClose}
                className={rowCls(active)}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );

  // Only portal once mounted on the client — document.body doesn't
  // exist during server rendering.
  if (!mounted) return null;
  return createPortal(drawer, document.body);
}
