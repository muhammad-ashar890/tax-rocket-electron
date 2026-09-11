"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import {
  getFbrConnectionAction,
  type FbrConnectionView,
} from "@/app/actions/fbr";
import FbrConnectClient from "@/components/tax/fbr-connect-client";
import { StepHeading } from "@/components/tax/wizard-ui";

type WizardFbrStepProps = Readonly<{
  draftId?: string;
  onConnectionStatusChange?: (status: string) => void;
  taxPayable?: number | null;
  refundDue?: number | null;
  packetVersion?: number;
}>;

export function WizardFbrStep({
  draftId,
  onConnectionStatusChange,
  taxPayable,
  refundDue,
  packetVersion,
}: WizardFbrStepProps) {
  const [connection, setConnection] = useState<FbrConnectionView | null>(null);

  useEffect(() => {
    if (!draftId) {
      setConnection(null);
      return;
    }

    let mounted = true;
    getFbrConnectionAction(draftId).then((result) => {
      if (mounted && result.success) {
        setConnection(result.connection);
      }
    });

    return () => {
      mounted = false;
    };
  }, [draftId]);

  return (
    <div className="space-y-6">
      <StepHeading
        title="File with FBR"
        description="Connect to FBR, start filing, and complete any OTP, CAPTCHA, PIN, or payment step on this computer."
      />

      <div className="rounded-xl border border-amanah/20 bg-amanah/5 p-5">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amanah/10 text-amanah">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <p className="font-semibold text-foreground">
          FBR filing
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          TaxRocket never sees your OTP, CAPTCHA, or PIN. Complete those steps
          in the FBR window, then press Continue here.
        </p>
      </div>

      <FbrConnectClient
        draftId={draftId}
        initialConnection={connection}
        onConnectionStatusChange={onConnectionStatusChange}
        taxPayable={taxPayable}
        refundDue={refundDue}
        packetVersion={packetVersion}
      />
    </div>
  );
}
