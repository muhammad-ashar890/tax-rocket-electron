"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { ShieldCheck } from "lucide-react";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";
import { GoogleIcon } from "@/components/icons/google-icon";
import { AuthShell } from "@/components/auth/auth-shell";

export default function SignupPage() {
  const handleGoogleSignUp = () => {
    signIn("google", { callbackUrl: "/tax/dashboard" });
  };

  return (
    <AuthShell>
      <div className="w-full max-w-md rounded-3xl border border-gray-200 bg-white p-8 shadow-sm lg:border-0 lg:shadow-xl lg:shadow-gray-200/60 sm:p-10">
        <div className="mb-7 flex justify-center lg:justify-start">
          <TaxRocketLogo />
        </div>

        <h1 className="text-2xl font-bold text-gray-800 lg:text-left lg:text-3xl text-center">
          Create your Tax Rocket account
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-center text-sm text-gray-500 lg:mx-0 lg:max-w-none lg:text-left">
          Use Google to start your FBR filing workspace.
        </p>

        <button
          type="button"
          onClick={handleGoogleSignUp}
          className="mt-7 flex w-full items-center justify-center gap-2.5 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:shadow-md active:scale-[0.99]"
        >
          <GoogleIcon />
          Continue with Google
        </button>

        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-[#376952]/15 bg-[#376952]/5 p-3.5 text-xs leading-relaxed text-gray-600">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#376952]" />
          <span>
            Email/password sign-up is deferred until later to keep the MVP auth
            flow simple and stable.
          </span>
        </div>

        <p className="mt-7 text-center text-sm text-gray-500 lg:text-left">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-[#376952] underline underline-offset-2 hover:text-[#2e5a44]"
          >
            Log in
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
