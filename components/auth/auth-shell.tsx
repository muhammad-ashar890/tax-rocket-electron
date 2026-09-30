import type React from "react";
import { Check } from "lucide-react";

/**
 * AuthShell — shared visual frame for /login and /signup.
 *
 * Design intent: mirror the dashboard's hero-card language (gradient +
 * soft blur glow, rounded-full pill badges) but pushed further into a
 * dedicated brand moment, since these are the very first screens a
 * visitor sees. Left panel carries the "why TaxRocket" story; right
 * panel holds the actual auth card. Collapses to a single column
 * (brand panel hidden) on mobile/tablet so the form stays the focus
 * on small screens.
 */

const FEATURES = [
  "Guided, step-by-step FBR filing",
  "Supervised FBR Iris connection — you approve every step",
  "AI-assisted document reconciliation",
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    // Breaks out of the app shell's `mx-auto max-w-7xl px-4 py-6 ...`
    // container from layout.tsx so this screen spans the full browser
    // width edge-to-edge, exactly like the reference screenshot —
    // without touching layout.tsx or anything else.
    <div className="relative left-1/2 -ml-[50vw] -my-6 w-screen min-h-screen">
      <div className="flex min-h-screen w-full flex-col lg:flex-row">
        {/* ── Brand panel — hidden below lg ── */}
        <div className="relative hidden overflow-hidden bg-gradient-to-br from-[#2e5a44] via-[#376952] to-[#24402f] px-10 py-12 text-white lg:flex lg:w-[42%] lg:flex-col lg:justify-between xl:w-[38%]">
          <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -right-16 h-80 w-80 rounded-full bg-white/10 blur-3xl" />

          <div className="relative">
            <h2 className="mt-8 text-3xl font-bold leading-tight xl:text-4xl">
              Guided FBR filing,
              <br />
              step by step.
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/80">
              TaxRocket walks you and your accountant through every stage — uploads, reconciliation, approval, and
              secure filing with FBR Iris.
            </p>

            <ul className="mt-9 space-y-4">
              {FEATURES.map((feature) => (
                <li key={feature} className="flex items-start gap-3 text-sm text-white/90">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/15">
                    <Check className="h-3 w-3" />
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
          </div>

          <p className="relative text-xs text-white/55">
            Every OTP, CAPTCHA, and PIN stays in your hands — TaxRocket never sees or stores them.
          </p>
        </div>

        {/* ── Form panel ── */}
        <div className="flex flex-1 items-center justify-center bg-[#F7FAF8] px-4 py-10 sm:px-6 lg:bg-white lg:px-10">
          {children}
        </div>
      </div>
    </div>
  );
}