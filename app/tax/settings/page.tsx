"use client";

import { useEffect, useState } from "react";

import {
  getCurrentSessionInfoAction,
  getUserSettingsAction,
  updateUserSettingsAction,
} from "@/app/actions/settings";
import {
  Bell,
  CheckCircle2,
  Loader2,
  Lock,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { DashboardSidebar } from "@/components/tax/dashboard-sidebar";

/* ────────────────────────────────────────────────────────────────
   Settings Page — Self-contained, matches the provided screenshots.
   Sidebar from the screenshots is intentionally NOT built here (per
   brief — "sidebar ignore kardena"); this page assumes it sits inside
   the existing SiteHeader + <main max-w-7xl> shell from layout.tsx,
   same as the Profile page.

   Tabs: Notifications · Security · Practice
   ("Account" tab intentionally excluded per brief.)

   Responsive: header/tab-bar/content stack cleanly on mobile, tab
   bar scrolls horizontally instead of wrapping, toggle rows stack
   label above control on very narrow screens, Practice's two-column
   inputs collapse to one column below sm.
─────────────────────────────────────────────────────────────── */

type TabKey = "notifications" | "security" | "practice";

const TABS: { key: TabKey; label: string; icon: typeof Bell }[] = [
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "security", label: "Security", icon: Lock },
  { key: "practice", label: "Practice", icon: SlidersHorizontal },
];

/* Default tax year is managed from Profile → Tax Preferences. */

/* ── Reusable toggle row (title + description + switch) ── */
function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="pr-2">
        <div className="text-sm font-medium text-gray-800">{title}</div>
        <div className="mt-0.5 text-xs text-gray-500">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 shrink-0 self-start rounded-full border-2 border-transparent transition-colors sm:self-auto ${
          checked ? "bg-[#376952]" : "bg-gray-200"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("notifications");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<{
    name: string | null;
    email: string;
    expires: string | null;
    provider: string;
  } | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);

  const [notifications, setNotifications] = useState({
    filingStatus: true,
    documentProcessing: true,
    riskFlags: true,
    paymentReminders: false,
    fbrConnect: true,
  });

  const [practice, setPractice] = useState({
    taxYear: "2026",
    currency: "PKR",
    autoGeneratePackets: false,
  });

  useEffect(() => {
    let isMounted = true;

    getUserSettingsAction().then((result) => {
      if (!isMounted) return;
      if (result.success && result.settings) {
        setNotifications((previous) => ({
          ...previous,
          ...result.settings.notifications,
        }));
        setPractice((previous) => ({
          ...previous,
          ...result.settings.practice,
        }));
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleViewSessions = async () => {
    setLoadingSession(true);
    const result = await getCurrentSessionInfoAction();
    setLoadingSession(false);

    if (result.success && result.session) {
      setSessionInfo(result.session);
    } else {
      alert(result.error ?? "Failed to load session information");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const result = await updateUserSettingsAction({
      notifications,
      practice,
    });
    setSaving(false);

    if (result.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      alert("Error: " + result.error);
    }
  };

  const inputCls =
    "h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-[#376952] focus:ring-2 focus:ring-[#376952]/20";

  const labelCls = "mb-1.5 block text-xs font-medium text-gray-500";

  const cardHeading = (title: string, description: string) => (
    <div className="mb-5">
      <h2 className="text-base font-semibold text-gray-800">{title}</h2>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      {/* ── Left Sidebar Added ── */}
      <DashboardSidebar />

      <div className="lg:min-w-0">
        {/* ── Header card — matches the filing wizard's page-header
            pattern: solid icon chip + title + subtitle, side by side.
            Kept consistent with the Profile page. ── */}
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#376952] text-white shadow-sm">
            <SettingsIcon className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold text-gray-800 sm:text-xl">
              Settings
            </h1>
            <p className="text-sm text-gray-500">
              Manage your notifications, security, and practice preferences.
            </p>
          </div>
        </div>

        {/* ── Tabs + content ── */}
        <div className="flex flex-col gap-6">
          <nav className="flex gap-1 overflow-x-auto rounded-xl bg-gray-100 p-1.5 scrollbar-none w-full">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors sm:flex-1 ${
                    isActive
                      ? "bg-white text-gray-800 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* ── Content card ── */}
          <div className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            {activeTab === "notifications" && (
              <div>
                {cardHeading(
                  "Notification preferences",
                  "Choose what notifications you receive and how.",
                )}
                <div className="space-y-3">
                  <ToggleRow
                    title="Filing status updates"
                    description="Get notified when your filing status changes"
                    checked={notifications.filingStatus}
                    onChange={(v) =>
                      setNotifications((p) => ({ ...p, filingStatus: v }))
                    }
                  />
                  <ToggleRow
                    title="Document processing"
                    description="Alerts when document extraction completes or fails"
                    checked={notifications.documentProcessing}
                    onChange={(v) =>
                      setNotifications((p) => ({ ...p, documentProcessing: v }))
                    }
                  />
                  <ToggleRow
                    title="Risk flags"
                    description="Notifications when new risk flags are detected"
                    checked={notifications.riskFlags}
                    onChange={(v) =>
                      setNotifications((p) => ({ ...p, riskFlags: v }))
                    }
                  />
                  <ToggleRow
                    title="Payment reminders"
                    description="Reminders for upcoming tax payment deadlines"
                    checked={notifications.paymentReminders}
                    onChange={(v) =>
                      setNotifications((p) => ({ ...p, paymentReminders: v }))
                    }
                  />
                  <ToggleRow
                    title="FBR Connect updates"
                    description="Job status updates for portal automation"
                    checked={notifications.fbrConnect}
                    onChange={(v) =>
                      setNotifications((p) => ({ ...p, fbrConnect: v }))
                    }
                  />
                </div>
              </div>
            )}

            {activeTab === "security" && (
              <div>
                {cardHeading(
                  "Security settings",
                  "Manage your password and authentication methods.",
                )}
                <div className="space-y-3">
                  <div className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#376952]/10 text-[#376952]">
                        <ShieldCheck className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="text-sm font-medium text-gray-800">
                          Google authentication
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500">
                          You are signed in with Google
                        </div>
                      </div>
                    </div>
                    <span className="w-fit self-start rounded-full border border-[#376952]/30 bg-[#376952]/10 px-2.5 py-1 text-xs font-medium text-[#376952] sm:self-auto">
                      Active
                    </span>
                  </div>

                  <div className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-medium text-gray-800">
                        Session management
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500">
                        View and manage active sessions
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleViewSessions}
                      disabled={loadingSession}
                      className="w-fit shrink-0 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {loadingSession ? "Loading…" : "View session"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "practice" && (
              <div>
                {cardHeading(
                  "Practice preferences",
                  "Configure defaults for your tax practice.",
                )}
                <div className="space-y-5">
                  <div className="max-w-sm">
                    <label className={labelCls}>Currency</label>
                    <input
                      className={`${inputCls} cursor-not-allowed bg-gray-50 text-gray-400`}
                      value={practice.currency}
                      disabled
                      readOnly
                    />
                  </div>

                  <div className="space-y-3">
                    <ToggleRow
                      title="Auto-generate packets"
                      description="Generate the packet automatically after you explicitly approve the filing data"
                      checked={practice.autoGeneratePackets}
                      onChange={(v) =>
                        setPractice((p) => ({ ...p, autoGeneratePackets: v }))
                      }
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Save bar — shown for editable tabs only (Security has no
          form fields to persist, so no Save button there, matching
          the screenshots). Left-padded on md+ so it lines up under
          the content column rather than the sidebar. ── */}
        {activeTab !== "security" && (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex w-fit items-center justify-center gap-1.5 rounded-lg bg-[#376952] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2e5a44] disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving…" : "Save changes"}
            </button>
            {saved && (
              <span className="flex items-center gap-1.5 text-sm text-[#376952]">
                <CheckCircle2 className="h-4 w-4" />
                Settings saved
              </span>
            )}
          </div>
        )}

        {sessionInfo && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
            onClick={() => setSessionInfo(null)}
            role="presentation"
          >
            <div
              className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="current-session-title"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2
                    id="current-session-title"
                    className="text-base font-semibold text-gray-800"
                  >
                    Current session
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    This project currently uses one active Google session.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSessionInfo(null)}
                  className="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
                  aria-label="Close session details"
                >
                  ×
                </button>
              </div>
              <div className="mt-4 space-y-2 rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
                <div className="flex justify-between gap-4">
                  <span>Account</span>
                  <span className="text-right font-medium text-gray-800">
                    {sessionInfo.email}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Provider</span>
                  <span className="font-medium text-gray-800">
                    {sessionInfo.provider}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Expires</span>
                  <span className="font-medium text-gray-800">
                    {sessionInfo.expires
                      ? new Date(sessionInfo.expires).toLocaleString()
                      : "Not available"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
