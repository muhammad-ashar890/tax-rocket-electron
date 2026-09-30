import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  FileText,
  History,
  Link2,
  Scale,
  Sparkles,
  Upload,
  UserRound,
} from "lucide-react";

import { DashboardSidebar } from "@/components/tax/dashboard-sidebar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authOptions } from "@/lib/auth";
import {
  WorkflowHeader,
  WorkflowPageShell,
} from "@/components/tax/workflow-page-shell";

const STEPS: {
  icon: typeof UserRound;
  title: string;
  text: string;
  href?: string;
  linkLabel?: string;
}[] = [
  {
    icon: UserRound,
    title: "Complete your Profile",
    text: "Your name, CNIC, NTN and address. Every filing you create carries these details.",
    href: "/tax/profile",
    linkLabel: "Open Profile",
  },
  {
    icon: FileText,
    title: "Start a New Filing",
    text: "Pick the tax year (2026), tell us your income sources, and add your bank accounts.",
    href: "/tax/new",
    linkLabel: "Start Filing",
  },
  {
    icon: Upload,
    title: "Upload documents",
    text: "Salary slips, bank statements, tax deduction certificates — the wizard guides each upload.",
  },
  {
    icon: Sparkles,
    title: "Review & classify",
    text: "AI-assisted extraction reads your documents; you confirm categories and fix anything wrong.",
  },
  {
    icon: Scale,
    title: "Mizan wealth check",
    text: "Bank inflows are reconciled against declared income. Genuine gaps get a written explanation.",
  },
  {
    icon: CheckCircle2,
    title: "Approve your packet",
    text: "Review the fully computed return — every rupee traceable — then approve it for filing.",
  },
  {
    icon: Link2,
    title: "Connect & file with FBR",
    text: "The desktop agent submits under your supervision. OTP, CAPTCHA and PIN stay in your hands.",
    href: "/tax/fbr-connect",
    linkLabel: "Open FBR Connect",
  },
  {
    icon: History,
    title: "Track in History",
    text: "Every draft, packet version and submission lives in History — reopen or download anytime.",
    href: "/tax/history",
    linkLabel: "Open History",
  },
];

const NTN_POINTS: { title: string; text: string }[] = [
  {
    title: "Individuals: your CNIC becomes your NTN",
    text: "Register on FBR Iris e-enrollment — FBR issues the NTN against your CNIC. No separate card or number to wait for.",
  },
  {
    title: "Enter both in your TaxRocket Profile",
    text: "CNIC (XXXXX-XXXXXXX-X) and 7-digit NTN go in Profile once, and every filing carries them automatically.",
  },
  {
    title: "Filer / ATL status comes from filing",
    text: "FBR marks you Active after your return is filed. File each year through the steps above to stay on the list.",
  },
];

export default async function GuidePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/login");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <DashboardSidebar />

      <WorkflowPageShell className="lg:min-w-0">
        <WorkflowHeader
          title="Guide"
          description="How TaxRocket takes you from signup to a filed FBR return — plus the NTN / CNIC essentials."
          showProgress={false}
          actions={
            <Button asChild className="gap-2">
              <Link href="/tax/new">
                Start New Filing
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          }
        />

        {/* ── How it works ─────────────────────────────────── */}
        <section id="how-it-works" className="scroll-mt-20">
          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
              <CardDescription>
                Eight steps from profile to filed return. Steps 4–6 happen
                inside the filing wizard.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ol className="divide-y">
                {STEPS.map((step, index) => (
                  <li
                    key={step.title}
                    className="flex items-start gap-4 p-4 sm:p-5"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#376952] text-sm font-semibold text-white">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <step.icon className="h-4 w-4 shrink-0 text-[#376952]" />
                        {step.title}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {step.text}
                      </p>
                      {step.href && (
                        <Link
                          href={step.href}
                          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-[#376952] hover:underline"
                        >
                          {step.linkLabel}
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </section>

        {/* ── NTN / CNIC mini-guide ────────────────────────── */}
        <section id="ntn-cnic" className="scroll-mt-20">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-[#376952]" />
                NTN / CNIC Guide
              </CardTitle>
              <CardDescription>
                The three things every individual filer needs to know.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {NTN_POINTS.map((point) => (
                <div key={point.title} className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#376952]" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {point.title}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {point.text}
                    </p>
                  </div>
                </div>
              ))}
              <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                <Button asChild size="sm" className="gap-2">
                  <Link href="/tax/profile">
                    Enter CNIC / NTN in Profile
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline" className="gap-2">
                  <a
                    href="https://iris.fbr.gov.pk"
                    target="_blank"
                    rel="noreferrer"
                  >
                    FBR Iris e-Registration
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </WorkflowPageShell>
    </div>
  );
}
