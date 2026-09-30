import { createHash, randomBytes } from "crypto";
import { getFbrDesktopAuthConfig } from "./fbr-agent-config";

export function generateLaunchToken(): string {
  return randomBytes(32).toString("hex"); // 64 chars
}

export function generatePartitionKey(userId: string): string {
  // Per-user STABLE partition key. The Electron partition is the browser
  // profile that holds the IRIS login session (cookies), so it must stay the
  // same across sessions — a random suffix here silently logged the user out
  // of the agent window on every reconnect. Same user => same partition =>
  // the IRIS login survives between "Open agent" clicks and job runs.
  const hash = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  return `fbr-iris-${hash}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateDeviceId(): string {
  return `dev_${randomBytes(8).toString("hex")}`;
}

export type DesktopSessionConfig = {
  launchToken: string;
  partitionKey: string;
  deviceTokenHash: string;
  deepLink: string;
  localhostUrl: string;
  expiresAt: string;
  irisLoginUrl: string;
  irisReadySelector: string;
  readyUrlPattern: string;
};

export function normalizeAccountReference(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

export function chooseDesktopAccountReference(params: {
  filerType?: string | null;
  cnic?: string | null;
  ntn?: string | null;
}) {
  const cnic = normalizeAccountReference(params.cnic);
  const ntn = normalizeAccountReference(params.ntn);
  return params.filerType === "my_business" ? ntn || cnic : cnic || ntn;
}

export function buildDesktopSessionConfig(params: {
  launchToken: string;
  partitionKey: string;
  deviceTokenHash: string;
  accountReference?: string | null;
}): DesktopSessionConfig {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const auth = getFbrDesktopAuthConfig();
  const irisLoginUrl = auth.loginUrl;
  const irisReadySelector = auth.readySelector;
  const readyUrlPattern = auth.readyUrlPattern || "";
  const query = new URLSearchParams({
    token: params.launchToken,
    partition: params.partitionKey,
    apiBaseUrl: baseUrl,
    baseUrl,
    flow: "fbr",
    loginUrl: irisLoginUrl,
    readySelector: irisReadySelector,
    readyUrlPattern,
    rejectSelector: auth.readyRejectSelector || "",
    accountReference: normalizeAccountReference(params.accountReference),
  });

  return {
    launchToken: params.launchToken,
    partitionKey: params.partitionKey,
    deviceTokenHash: params.deviceTokenHash,
    deepLink: `taxrocket-connect://connect?${query}`,
    // Bridge requires a nonce/allowlist/confirmation handshake; the web UI
    // intentionally uses the registered protocol only, never both transports.
    localhostUrl: "http://127.0.0.1:37219/connect",
    expiresAt,
    irisLoginUrl,
    irisReadySelector,
    readyUrlPattern,
  };
}

export const JOB_TYPES = {
  TAX_DRY_RUN: "tax_dry_run",
  TAX_ASSISTED_FILING: "tax_assisted_filing",
} as const;

export const JOB_STATUSES = {
  CREATED: "created",
  OFFERED_TO_DEVICE: "offered_to_device",
  ACCEPTED_BY_DEVICE: "accepted_by_device",
  RUNNING: "running",
  AWAITING_USER_ACTION: "awaiting_user_action",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const;

export const PAUSE_ACTIONS = {
  PORTAL_INSPECTION: "portal_inspection",
  PORTAL_POPUP: "portal_popup",
  PORTAL_ECONOMIC_TRANSACTIONS_GATE: "portal_economic_transactions_gate",
  SESSION_RECONNECT: "session_reconnect",
  SELECTOR_BUNDLE_UPDATE: "selector_bundle_update",
  PASSWORD_RESET: "password_reset",
  OTP: "otp_required",
  OTP_CAPTCHA_PIN: "otp_captcha_pin",
  CAPTCHA: "captcha_required",
  PIN: "pin_required",
  CLASSIC_PIN_ENTRY: "classic_pin_entry", // legacy naming from worker.md
  PSID: "psid_payment",
  PAYMENT_PSID: "payment_psid",
  FINAL_REVIEW: "final_review",
  FINAL_SUBMIT_CONFIRMATION: "final_submit_confirmation",
  CLASSIC_FINAL_REVIEW: "classic_final_review", // legacy
  PAYMENT: "payment_required",
} as const;

export function isValidPauseAction(action: string): boolean {
  return (
    Object.values(PAUSE_ACTIONS).includes(action as any) ||
    [
      "classic_final_review",
      "classic_pin_entry",
      "otp",
      "captcha",
      "pin",
      "psid",
      "final_review",
      "password_reset",
      "otp_captcha_pin",
      "payment_psid",
      "final_submit_confirmation",
    ].includes(action)
  );
}

export function normalizePauseAction(action: string): string {
  const mapping: Record<string, string> = {
    classic_final_review: PAUSE_ACTIONS.CLASSIC_FINAL_REVIEW,
    classic_pin_entry: PAUSE_ACTIONS.CLASSIC_PIN_ENTRY,
    otp: PAUSE_ACTIONS.OTP,
    captcha: PAUSE_ACTIONS.CAPTCHA,
    pin: PAUSE_ACTIONS.PIN,
    psid: PAUSE_ACTIONS.PSID,
    final_review: PAUSE_ACTIONS.FINAL_REVIEW,
    password_reset: PAUSE_ACTIONS.PASSWORD_RESET,
    otp_captcha_pin: PAUSE_ACTIONS.OTP_CAPTCHA_PIN,
    payment_psid: PAUSE_ACTIONS.PAYMENT_PSID,
    payment_required: PAUSE_ACTIONS.PAYMENT_PSID,
    final_submit_confirmation: PAUSE_ACTIONS.FINAL_SUBMIT_CONFIRMATION,
  };
  return mapping[action] || action;
}
