"use client";

import type React from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  WizardActionCard,
  WizardSummaryPanel,
  WizardStepsRail,
  WizardStepsRailCompact,
} from "@/components/tax/wizard-ui";
import type { StepsRailItem } from "@/components/tax/wizard-ui";

type WizardShellLayoutProps = Readonly<{
  showRail: boolean;
  railItems: StepsRailItem[];
  summaryRows: {
    label: string;
    value: string;
    details?: { label: string; value: string }[];
  }[];
  blockers: string[];
  onRailItemClick: (index: number) => void;
  children: React.ReactNode;
}>;

export function WizardShellLayout({
  showRail,
  railItems,
  summaryRows,
  blockers,
  onRailItemClick,
  children,
}: WizardShellLayoutProps) {
  return (
    <div className="mt-6 grid min-w-0 items-start gap-6 lg:grid-cols-[220px_1fr_280px]">
      {showRail ? (
        <aside className="min-w-0 lg:sticky lg:top-20 lg:z-10 lg:self-start">
          <div className="lg:hidden">
            <WizardStepsRailCompact
              items={railItems}
              onItemClick={onRailItemClick}
            />
          </div>
          <Card className="hidden p-2 shadow-sm lg:block">
            <WizardStepsRail items={railItems} onItemClick={onRailItemClick} />
          </Card>
        </aside>
      ) : (
        <div className="hidden lg:block" />
      )}

      <Card className="min-w-0 shadow-sm lg:self-start">
        <CardContent className="p-6 sm:p-8">{children}</CardContent>
      </Card>

      <aside className="min-w-0 lg:sticky lg:top-20 lg:z-10 lg:self-start">
        <WizardSummaryPanel rows={summaryRows} />
        <WizardActionCard blockers={blockers} />
      </aside>
    </div>
  );
}
