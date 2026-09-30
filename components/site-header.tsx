"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import {
  Bell,
  HelpCircle,
  LogOut,
  Menu,
  Settings,
  UserRound,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";
import { MobileNavDrawer } from "@/components/mobile-nav-drawer";
import { getUserProfile } from "@/app/actions/user";
import {
  getNotificationsAction,
  markAllNotificationsReadAction,
  type NotificationView,
} from "@/app/actions/notifications";

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function SiteHeader() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);

  // Real NextAuth session is the only source of authentication state.
  const { data: session, status } = useSession();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const syncProfileImage = () => {
      if (status !== "authenticated") {
        setProfileImage(null);
        return;
      }

      getUserProfile().then((result) => {
        if (result.success) {
          setProfileImage(result.user?.image || null);
        }
      });
    };

    syncProfileImage();
    window.addEventListener("taxrocket-profile-updated", syncProfileImage);

    return () => {
      window.removeEventListener("taxrocket-profile-updated", syncProfileImage);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;

    let cancelled = false;
    const loadNotifications = async () => {
      const result = await getNotificationsAction();
      if (!cancelled && result.success) {
        setNotifications(result.notifications);
        setUnreadCount(result.unreadCount);
      }
    };

    void loadNotifications();
    const interval = setInterval(loadNotifications, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status]);

  const handleBellOpenChange = async (open: boolean) => {
    setBellOpen(open);
    if (open && unreadCount > 0) {
      setNotifications((previous) =>
        previous.map((notification) => ({ ...notification, isRead: true })),
      );
      setUnreadCount(0);
      await markAllNotificationsReadAction();
    }
  };

  // Close the drawer whenever the route changes
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Do not leave a protected tax screen visible after logout/session expiry.
  useEffect(() => {
    if (
      mounted &&
      status === "unauthenticated" &&
      pathname.startsWith("/tax")
    ) {
      window.location.replace("/login");
    }
  }, [mounted, pathname, status]);

  // Lock background scroll while the drawer is open
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  // No header chrome on the auth screens themselves
  if (pathname === "/login" || pathname === "/signup") return null;

  // Fixed Initials Logic: First Letter of First Name + First Letter of Last Name
  const getInitialsFixed = (name: string) => {
    const parts = name.trim().split(" ");
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  const userName = session?.user?.name || "TX Dev";
  const userEmail = session?.user?.email || "tx.dev@example.com";
  const userImage = profileImage || session?.user?.image;

  // NextAuth is the only source of truth for authentication.
  const isAuthenticated = status === "authenticated";

  const handleLogout = async () => {
    await signOut({ redirect: false });
    window.location.replace("/login");
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/tax/dashboard" className="flex items-center gap-2">
          <TaxRocketLogo />
        </Link>

        {/* Reserve the space even pre-mount so nothing jumps on hydration. */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {!mounted ? null : (
            <>
              {isAuthenticated ? (
                <>
                  {/* Notification bell */}
                  <DropdownMenu
                    open={bellOpen}
                    onOpenChange={handleBellOpenChange}
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Notifications"
                        className="relative flex h-9 w-9 items-center justify-center rounded-full text-[#376952] transition-colors hover:bg-[#376952]/10"
                      >
                        <Bell className="h-[18px] w-[18px]" />
                        {unreadCount > 0 && (
                          <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
                            {unreadCount > 9 ? "9+" : unreadCount}
                          </span>
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-80">
                      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                        Notifications
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {notifications.length === 0 ? (
                        <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                          No new notices. FBR notices will show up here.
                        </div>
                      ) : (
                        <div className="max-h-80 overflow-y-auto">
                          {notifications.map((notification) => (
                            <Link
                              key={notification.id}
                              href={notification.link ?? "#"}
                              className="block border-b px-3 py-2.5 text-left hover:bg-gray-50"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs font-semibold text-foreground">
                                  {notification.title}
                                </p>
                                {!notification.isRead && (
                                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                                )}
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                {notification.message}
                              </p>
                              <p className="mt-1 text-[10px] text-muted-foreground/70">
                                {timeAgo(notification.createdAt)}
                              </p>
                            </Link>
                          ))}
                        </div>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Help — opens the Guide page */}
                  <Link
                    href="/tax/guide"
                    aria-label="Help"
                    title="Help & Guide"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-[#376952] transition-colors hover:bg-[#376952]/10"
                  >
                    <HelpCircle className="h-[18px] w-[18px]" />
                  </Link>

                  {/* Profile dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Account menu"
                        className="ml-1 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-[#376952] text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
                      >
                        {userImage ? (
                          <img
                            src={userImage}
                            alt={userName}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          getInitialsFixed(userName)
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="w-56 overflow-hidden"
                    >
                      <DropdownMenuLabel className="font-normal w-full overflow-hidden block">
                        <div className="text-sm font-medium text-foreground truncate w-full">
                          {userName}
                        </div>
                        <div className="text-xs text-muted-foreground truncate w-full mt-0.5 block">
                          {userEmail}
                        </div>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        asChild
                        className="cursor-pointer hover:bg-[#376952] hover:text-white focus:bg-[#376952] focus:text-white"
                      >
                        <Link
                          href="/tax/profile"
                          className="flex items-center gap-2"
                        >
                          <UserRound className="h-4 w-4" />
                          Profile
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        asChild
                        className="cursor-pointer hover:bg-[#376952] hover:text-white focus:bg-[#376952] focus:text-white"
                      >
                        <Link
                          href="/tax/settings"
                          className="flex items-center gap-2"
                        >
                          <Settings className="h-4 w-4" />
                          Settings
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={handleLogout}
                        className="flex cursor-pointer items-center gap-2 text-red-500 hover:bg-red-500 hover:text-white focus:bg-red-500 focus:text-white"
                      >
                        <LogOut className="h-4 w-4" />
                        Log out
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-800 hidden sm:block"
                  >
                    Log in
                  </Link>
                  <Link
                    href="/signup"
                    className="rounded-lg bg-[#376952] px-3.5 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#2e5a44]"
                  >
                    Sign Up
                  </Link>
                </>
              )}
            </>
          )}

          {/* Hamburger — mobile & tablet only */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open menu"
            className="ml-0.5 flex h-9 w-9 items-center justify-center rounded-full text-[#376952] transition-colors hover:bg-[#376952]/10 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      <MobileNavDrawer
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />
    </header>
  );
}
