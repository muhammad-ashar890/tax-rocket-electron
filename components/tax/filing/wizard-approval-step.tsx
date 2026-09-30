"use client";

import { ApprovalPacket } from "@/components/tax/approval-packet";
import { StepHeading } from "@/components/tax/wizard-ui";

type WizardApprovalStepProps = Readonly<{
  draftId?: string;
  approvalConfirmed: boolean;
  packetVersion?: number;
  approvalLocked?: boolean;
  approvalReady?: boolean;
  approvalBlockers?: string[];
  onApprovalChange: (checked: boolean) => void;
}>;

export function WizardApprovalStep({
  approvalConfirmed,
  packetVersion,
  approvalLocked = false,
  approvalReady = true,
  approvalBlockers = [],
  onApprovalChange,
}: WizardApprovalStepProps) {
  return (
    <div className="space-y-6">
      <StepHeading
        title="Approve your filing data"
        description="Review and approve the filing data before generating the final packet snapshot."
      />
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <ApprovalPacket
          onApprovalChange={onApprovalChange}
          initialApproved={approvalConfirmed}
          packetVersion={packetVersion ?? 1}
          prePacketApproval
          approvalLocked={approvalLocked}
          approvalReady={approvalReady}
          approvalBlockers={approvalBlockers}
        />
      </div>
    </div>
  );
}
