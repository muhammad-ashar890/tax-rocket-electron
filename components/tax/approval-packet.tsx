import { useEffect, useState } from "react";
import { CheckSquare, ShieldCheck } from "lucide-react";

export function ApprovalPacket({
  onApprovalChange,
  initialApproved = false,
  packetVersion = 1,
  prePacketApproval = false,
  approvalLocked = false,
  approvalReady = true,
  approvalBlockers = [],
}: {
  onApprovalChange?: (
    isApproved: boolean,
  ) => boolean | void | Promise<boolean | void>;
  initialApproved?: boolean;
  packetVersion?: number;
  prePacketApproval?: boolean;
  approvalLocked?: boolean;
  approvalReady?: boolean;
  approvalBlockers?: string[];
}) {
  const [isApproved, setIsApproved] = useState(initialApproved);

  useEffect(() => {
    setIsApproved(initialApproved);
  }, [initialApproved]);
  const [isSavingApproval, setIsSavingApproval] = useState(false);

  const handleChange = async (checked: boolean) => {
    const previousValue = isApproved;
    setIsApproved(checked);
    if (!onApprovalChange) return;

    setIsSavingApproval(true);
    try {
      const accepted = await onApprovalChange(checked);
      if (accepted === false) {
        setIsApproved(previousValue);
      }
    } catch {
      setIsApproved(previousValue);
    } finally {
      setIsSavingApproval(false);
    }
  };

  return (
    <div className="p-5 sm:p-6 bg-[#376952]/[0.02]">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="h-5 w-5 text-[#376952]" />
        <h2 className="text-lg font-semibold text-gray-800">
          {prePacketApproval
            ? "Approve for Packet Generation"
            : "Final Approval"}
        </h2>
      </div>

      <p className="text-sm text-gray-500 mb-5">
        {prePacketApproval
          ? "Review and approve the filing data before the final packet is generated."
          : "Please review and approve the packet."}{" "}
      </p>

      {!approvalReady && !approvalLocked && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">Approval is not ready yet</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {approvalBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Unified Approval Box */}
      <div
        className={`rounded-xl border p-4 transition-colors ${
          isApproved
            ? "border-[#376952] bg-white shadow-sm"
            : "border-gray-200 bg-white"
        }`}
      >
        <label className="flex items-start gap-3 cursor-pointer">
          <div className="relative flex items-center pt-0.5">
            <input
              type="checkbox"
              className="peer h-5 w-5 cursor-pointer appearance-none rounded-md border-2 border-gray-300 checked:border-[#376952] checked:bg-[#376952] transition-all"
              checked={isApproved}
              disabled={approvalLocked || !approvalReady || isSavingApproval}
              onChange={(e) => void handleChange(e.target.checked)}
            />
            <CheckSquare className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" />
          </div>
          <div>
            <p
              className={`text-sm font-medium ${isApproved ? "text-[#376952]" : "text-gray-700"}`}
            >
              {approvalLocked
                ? "Approval locked for the generated packet"
                : prePacketApproval
                  ? "I have reviewed and approve this filing data for packet generation"
                  : "I have reviewed and approve this filing packet"}
            </p>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed max-w-3xl">
              {prePacketApproval
                ? "By checking this, I confirm the filing data is ready for an immutable packet snapshot."
                : `By checking this, I confirm that I understand the tax payable/refund result, wealth reconciliation, and cleared risk items. I consent to local, user-controlled portal automation using this exact approved packet (v${packetVersion}).`}
            </p>
            {approvalLocked && (
              <p className="mt-2 text-xs font-medium text-amber-700">
                To change this approval, update the filing data first. The
                current packet will then be superseded and approval can be given
                again.
              </p>
            )}
          </div>
        </label>
      </div>

    </div>
  );
}

export default ApprovalPacket;
