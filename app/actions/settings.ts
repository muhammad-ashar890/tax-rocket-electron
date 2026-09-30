"use server";

import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSupportedTaxYear } from "@/lib/tax/tax-year-period";

export type NotificationPreferences = {
  filingStatus: boolean;
  documentProcessing: boolean;
  riskFlags: boolean;
  paymentReminders: boolean;
  fbrConnect: boolean;
};

export type PracticePreferences = {
  taxYear: string;
  currency: string;
  autoGeneratePackets: boolean;
};

export type SettingsInput = {
  notifications: NotificationPreferences;
  practice: PracticePreferences;
};

const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  filingStatus: true,
  documentProcessing: true,
  riskFlags: true,
  paymentReminders: false,
  fbrConnect: true,
};

const DEFAULT_PRACTICE: PracticePreferences = {
  taxYear: String(new Date().getFullYear()),
  currency: "PKR",
  autoGeneratePackets: false,
};

function parseJsonObject(value: string, fallback: Record<string, unknown>) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSettings(user: {
  notificationPreferences: string;
  practicePreferences: string;
  defaultTaxYear: number | null;
}) {
  const storedNotifications = parseJsonObject(user.notificationPreferences, {});
  const storedPractice = parseJsonObject(user.practicePreferences, {});

  return {
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...storedNotifications,
    } as NotificationPreferences,
    practice: {
      ...DEFAULT_PRACTICE,
      ...storedPractice,
      // The actual User.defaultTaxYear is the source used by the filing
      // setup/profile flow, so keep the Settings screen aligned with it.
      taxYear: String(
        user.defaultTaxYear ??
          storedPractice.taxYear ??
          DEFAULT_PRACTICE.taxYear,
      ),
      currency: "PKR",
    } as PracticePreferences,
  };
}

export async function getUserSettingsAction() {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) return { success: false, error: "Unauthorized" };

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        notificationPreferences: true,
        practicePreferences: true,
        defaultTaxYear: true,
      },
    });

    if (!user) return { success: false, error: "User profile not found" };

    return {
      success: true,
      settings: normalizeSettings(user),
    };
  } catch (error) {
    console.error("Error fetching settings:", error);
    return { success: false, error: "Failed to fetch settings" };
  }
}

export async function getCurrentSessionInfoAction() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return { success: false, error: "Unauthorized" };

    const parsedExpiry = session.expires ? new Date(session.expires) : null;
    const expires =
      parsedExpiry && !Number.isNaN(parsedExpiry.getTime())
        ? parsedExpiry.toISOString()
        : null;

    return {
      success: true,
      session: {
        name: session.user.name ?? null,
        email: session.user.email,
        expires,
        provider: "Google",
      },
    };
  } catch (error) {
    console.error("Error fetching current session:", error);
    return { success: false, error: "Failed to fetch current session" };
  }
}

export async function updateUserSettingsAction(input: SettingsInput) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) return { success: false, error: "Unauthorized" };

    const taxYear = Number(input.practice.taxYear);
    if (!Number.isInteger(taxYear) || !isSupportedTaxYear(taxYear)) {
      return {
        success: false,
        error: "Only Tax Year 2026 is currently supported",
      };
    }

    const notifications: NotificationPreferences = {
      ...DEFAULT_NOTIFICATIONS,
      ...input.notifications,
    };
    const practice: PracticePreferences = {
      ...DEFAULT_PRACTICE,
      ...input.practice,
      taxYear: String(taxYear),
      currency: "PKR",
    };

    await prisma.user.update({
      where: { email },
      data: {
        defaultTaxYear: taxYear,
        notificationPreferences: JSON.stringify(notifications),
        practicePreferences: JSON.stringify(practice),
      },
    });

    revalidatePath("/tax/settings");
    revalidatePath("/tax/profile");
    revalidatePath("/tax/new");
    return { success: true };
  } catch (error) {
    console.error("Error updating settings:", error);
    return { success: false, error: "Failed to save settings" };
  }
}
