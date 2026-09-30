/** Recovery is a retry, not evidence that a filing phase succeeded. */
export function getNextFbrPilotPhase(action: string, currentPhase: string): string {
  const nextPhase: Record<string, string> = {
    password_reset: "after_password_reset",
    otp_captcha_pin: "after_otp_captcha_pin",
    otp_required: "after_otp_captcha_pin",
    captcha_required: "after_otp_captcha_pin",
    pin_required: "after_otp_captcha_pin",
    payment_psid: "after_payment_psid",
    psid_payment: "after_payment_psid",
    payment_required: "after_payment_psid",
    final_submit_confirmation: "after_final_submit_confirmation",
    final_review: "after_final_submit_confirmation",
    // The classic worker expects this phase to display its PIN checkpoint.
    classic_final_review: "after_otp_captcha_pin",
    classic_pin_entry: "after_classic_pin_entry",
  };
  const normalized = String(action || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(nextPhase, normalized)
    ? nextPhase[normalized] : currentPhase;
}
