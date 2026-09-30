"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  FolderOpen,
  Home,
  Link2,
  Settings,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

// DashboardSidebar — left-hand navigation column for the dashboard,
// styled after the Befiler reference (left nav)
// but wired to TaxRocket's own
// routes and vocabulary (Ledgers/Mizan, FBR Connect, etc.) — no
// marketing content, no pricing links, matching the earlier decision to
// keep this purely functional.

const primaryLinks = [
  { href: "/tax/dashboard", label: "Home", icon: Home },
  { href: "/tax/new", label: "New Filing", icon: FileText },
  { href: "/tax/history", label: "History", icon: FolderOpen },
  { href: "/tax/fbr-connect", label: "FBR Connect", icon: Link2 },
  { href: "/tax/profile", label: "Profile", icon: User },
  { href: "/tax/settings", label: "Settings", icon: Settings },
];

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:block">
      <div className="space-y-4 lg:sticky lg:top-20">
        <nav className="rounded-2xl border bg-card p-2 shadow-sm">
          {primaryLinks.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-amanah text-white shadow-sm"
                    : "text-foreground hover:bg-muted",
                )}
              >
                <link.icon className="h-4 w-4 shrink-0" />
                {link.label}
              </Link>
            );
          })}
        </nav>

      </div>
    </aside>
  );
}
