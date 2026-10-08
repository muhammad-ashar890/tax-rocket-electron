import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Receipt } from "lucide-react";
import { getServerSession } from "next-auth/next";

import { getSalesTaxOverviewAction } from "@/app/actions/sales-tax";
import { DashboardSidebar } from "@/components/tax/dashboard-sidebar";
import { SalesTaxFilingList } from "@/components/tax/sales-tax/filing-list";
import { Button } from "@/components/ui/button";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SalesTaxPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) redirect("/login");

  const overview = await getSalesTaxOverviewAction();

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <DashboardSidebar />

      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amanah/10 text-amanah">
              <Receipt className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Sales Tax</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Monthly sales tax returns, prepared from your invoices. This is
                separate from your income tax filing.
              </p>
            </div>
          </div>
          {overview.success && (
            <Button asChild className="gap-2">
              <Link href="/tax/sales-tax/new">
                <Plus className="h-4 w-4" />
                New sales tax return
              </Link>
            </Button>
          )}
        </div>

        {!overview.success && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {overview.error}
          </p>
        )}

        {overview.success && overview.profile && (
          <p className="text-sm text-muted-foreground">
            {overview.profile.businessName} · STRN{" "}
            {overview.profile.registrationNo}
          </p>
        )}

        {overview.success && (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">
              Your returns
            </h2>
            <SalesTaxFilingList filings={overview.filings} />
          </section>
        )}
      </div>
    </div>
  );
}
