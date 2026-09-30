"use client";

import {
  BadgeDollarSign,
  BadgePercent,
  Banknote,
  Briefcase,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  Coins,
  FileText,
  Globe2,
  HandCoins,
  Handshake,
  Landmark,
  LaptopMinimal,
  Leaf,
  Link2,
  ReceiptText,
  Route,
  ScrollText,
  Ship,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BigChoiceCard,
  CompactSelectableCard,
  StepHeading,
} from "@/components/tax/wizard-ui";
import type {
  TaxIncomeSource,
  TaxReadinessItem,
} from "@/lib/tax/filing-drafts";
import type { DraftBankAccount } from "@/components/tax/filing/config/bank-account-types";
import { SUPPORTED_TAX_YEARS } from "@/lib/tax/tax-year-period";
import type { Ty2026SubcategoryStepKey } from "@/lib/tax/rules/ty2026/subcategories";

export type SetupStepKey =
  | "who"
  | "structure"
  | "income"
  | "bank_accounts"
  | "salary_split"
  | "tax_year"
  | "residency"
  | "readiness"
  | "review"
  | Ty2026SubcategoryStepKey;

type WizardSetupStepProps = Readonly<{
  currentStepKey: SetupStepKey;
  filerType: "myself" | "my_business" | null;
  businessStructure: string | null;
  incomeSources: TaxIncomeSource[];
  bankAccounts: DraftBankAccount[];
  salaryPercentage: "over_50" | "under_50" | null;
  taxYear: number;
  residencyStatus: "resident" | "non_resident" | null;
  readinessCompleted: TaxReadinessItem[];
  showStructureRow: boolean;
  needsIncomeSourceSelection: boolean;
  documentRequirementSummary: string;
  requiredDocumentLabels: string[];
  eligibilityRouteLabel: string;
  eligibilityRouteTone: "muted" | "amanah" | "mizan" | "risk";
  canSubmit: boolean;
  onFilerTypeChange: (value: "myself" | "my_business") => void;
  onBusinessStructureChange: (value: string) => void;
  onIncomeSourceToggle: (value: TaxIncomeSource) => void;
  onBankAccountsChange: (accounts: DraftBankAccount[]) => void;
  onSalaryPercentageChange: (value: "over_50" | "under_50") => void;
  onTaxYearChange: (value: number) => void;
  onResidencyStatusChange: (value: "resident" | "non_resident") => void;
  onReadinessToggle: (value: TaxReadinessItem) => void;
}>;

const incomeSourceOptions: ReadonlyArray<{
  value: TaxIncomeSource;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "salary", label: "Salary", icon: BriefcaseBusiness },
  { value: "pension", label: "Pension", icon: HandCoins },
  { value: "property_rent", label: "Rental Income", icon: Building2 },
  { value: "services", label: "Freelancer", icon: LaptopMinimal },
  { value: "bank_profit", label: "Bank Profit", icon: Landmark },
  { value: "dividend", label: "Dividend", icon: Banknote },
  { value: "capital_gains", label: "Capital Gains", icon: Coins },
  { value: "business", label: "Business Income", icon: BadgeDollarSign },
  { value: "agriculture", label: "Agriculture", icon: Leaf },
  { value: "foreign_income_assets", label: "Non-Resident", icon: Link2 },
  { value: "aop_company_links", label: "AOP / Company", icon: Handshake },
  {
    value: "sales_tax_fed_withholding",
    label: "Sales Tax / FED",
    icon: ReceiptText,
  },
  { value: "other_income", label: "Other Income", icon: FileText },
  { value: "imports", label: "Imports", icon: Ship },
  { value: "advance_tax", label: "Advance Tax", icon: BadgePercent },
];

const readinessOptions: ReadonlyArray<{
  value: TaxReadinessItem;
  label: string;
  icon: LucideIcon;
}> = [
  {
    value: "previous_return_available",
    label: "Previous Return",
    icon: FileText,
  },
  { value: "core_documents_ready", label: "Core Documents", icon: FileText },
];

const businessStructureOptions = [
  {
    value: "sole_proprietor",
    icon: UserRound,
    label: "Sole Proprietor",
    desc: "Single owner, personal liability",
  },
  {
    value: "aop",
    icon: Handshake,
    label: "AOP",
    desc: "Association of Persons / Partnership",
  },
  {
    value: "company",
    icon: Building2,
    label: "Company",
    desc: "Private or public limited company",
  },
  {
    value: "tax_practitioner",
    icon: ScrollText,
    label: "Tax Practitioner",
    desc: "Filing for multiple clients",
  },
] as const;

export function WizardSetupStep({
  currentStepKey,
  filerType,
  businessStructure,
  incomeSources,
  bankAccounts,
  salaryPercentage,
  taxYear,
  residencyStatus,
  readinessCompleted,
  showStructureRow,
  needsIncomeSourceSelection,
  documentRequirementSummary,
  requiredDocumentLabels,
  eligibilityRouteLabel,
  eligibilityRouteTone,
  canSubmit,
  onFilerTypeChange,
  onBusinessStructureChange,
  onIncomeSourceToggle,
  onBankAccountsChange,
  onSalaryPercentageChange,
  onTaxYearChange,
  onResidencyStatusChange,
  onReadinessToggle,
}: WizardSetupStepProps) {
  const routeToneClass = {
    muted: "border-border bg-muted/40 text-muted-foreground",
    amanah: "text-amanah border-amanah/25 bg-amanah/10",
    mizan: "text-mizan-foreground border-mizan/40 bg-mizan/20",
    risk: "text-destructive border-destructive/25 bg-destructive/10",
  }[eligibilityRouteTone];

  if (currentStepKey === "who") {
    return (
      <div className="space-y-6">
        <StepHeading
          title="Who is filing?"
          description="Are you filing for yourself or for your business?"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <BigChoiceCard
            icon={UserRound}
            title="Myself"
            description="Individual"
            selected={filerType === "myself"}
            onClick={() => onFilerTypeChange("myself")}
          />
          <BigChoiceCard
            icon={Briefcase}
            title="My Business / Client"
            description="Business or practitioner"
            selected={filerType === "my_business"}
            onClick={() => onFilerTypeChange("my_business")}
          />
        </div>
      </div>
    );
  }

  if (currentStepKey === "structure") {
    return (
      <div className="space-y-6">
        <StepHeading
          title="Choose your business structure"
          description="Select the structure that best describes your business."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {businessStructureOptions.map((option) => (
            <BigChoiceCard
              key={option.value}
              icon={option.icon}
              title={option.label}
              description={option.desc}
              selected={businessStructure === option.value}
              onClick={() => onBusinessStructureChange(option.value)}
            />
          ))}
        </div>
      </div>
    );
  }

  if (currentStepKey === "income") {
    return (
      <div className="space-y-6">
        <StepHeading
          title="What describes your income?"
          description="Select all that apply. This determines which income-category steps and documents you'll need."
        />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {incomeSourceOptions.map((source) => (
            <CompactSelectableCard
              key={source.value}
              icon={source.icon}
              label={source.label}
              selected={incomeSources.includes(source.value)}
              onClick={() => onIncomeSourceToggle(source.value)}
            />
          ))}
        </div>
      </div>
    );
  }

  if (currentStepKey === "bank_accounts") {
    function updateAccount(index: number, patch: Partial<DraftBankAccount>) {
      onBankAccountsChange(
        bankAccounts.map((account, accountIndex) =>
          accountIndex === index ? { ...account, ...patch } : account,
        ),
      );
    }

    function addAccount() {
      onBankAccountsChange([
        ...bankAccounts,
        {
          clientId: crypto.randomUUID(),
          bankName: "",
          accountLabel: `Account ${bankAccounts.length + 1}`,
        },
      ]);
    }

    function removeAccount(index: number) {
      if (bankAccounts.length <= 1) return;
      onBankAccountsChange(
        bankAccounts.filter((_, accountIndex) => accountIndex !== index),
      );
    }

    return (
      <div className="space-y-6">
        <StepHeading
          title="Which bank accounts did you use?"
          description="Add every account used during this tax year. Statements will be uploaded separately later."
        />
        <div className="space-y-4">
          {bankAccounts.map((account, index) => (
            <div
              key={account.clientId}
              className="rounded-xl border bg-card p-4 shadow-sm"
            >
              <div className="mb-4 flex items-center justify-between">
                <p className="font-semibold">Bank account {index + 1}</p>
                {bankAccounts.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => removeAccount(index)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1 text-sm font-medium">
                  Bank name
                  <input
                    value={account.bankName}
                    onChange={(event) =>
                      updateAccount(index, { bankName: event.target.value })
                    }
                    placeholder="HBL, Meezan Bank"
                    className="flex h-11 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal"
                  />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  Account label
                  <input
                    value={account.accountLabel}
                    onChange={(event) =>
                      updateAccount(index, { accountLabel: event.target.value })
                    }
                    placeholder="Salary account"
                    className="flex h-11 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={addAccount}>
          + Add another bank account
        </Button>
      </div>
    );
  }

  if (currentStepKey === "salary_split") {
    return (
      <div className="space-y-6">
        <StepHeading title="Is salary more than 50% of your income?" />
        <div className="grid gap-4 sm:grid-cols-2">
          <BigChoiceCard
            icon={BriefcaseBusiness}
            title="Yes — Salary is majority"
            description="Salaried path — simplified workflow"
            selected={salaryPercentage === "over_50"}
            onClick={() => onSalaryPercentageChange("over_50")}
          />
          <BigChoiceCard
            icon={BadgeDollarSign}
            title="No — Other sources dominate"
            description="More review steps"
            selected={salaryPercentage === "under_50"}
            onClick={() => onSalaryPercentageChange("under_50")}
          />
        </div>
      </div>
    );
  }

  if (currentStepKey === "tax_year") {
    const years = [...SUPPORTED_TAX_YEARS];
    return (
      <div className="space-y-6">
        <StepHeading
          title="Which tax year is this for?"
          description="Choose from the most recent tax years."
        />
        <div className="max-w-xs">
          <label
            htmlFor="taxYear"
            className="mb-2 block text-sm font-medium text-foreground"
          >
            Tax year
          </label>
          <select
            id="taxYear"
            value={taxYear}
            onChange={(event) => onTaxYearChange(Number(event.target.value))}
            className="flex h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  if (currentStepKey === "residency") {
    return (
      <div className="space-y-6">
        <StepHeading
          title="What is your tax residency status?"
          description="Choose the status that applies to this return. TaxRocket will pass this exact choice to IRIS; it will not assume Resident."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <BigChoiceCard
            icon={UserRound}
            title="Resident"
            description="I am a tax resident of Pakistan for this return."
            selected={residencyStatus === "resident"}
            onClick={() => onResidencyStatusChange("resident")}
          />
          <BigChoiceCard
            icon={Globe2}
            title="Non-Resident"
            description="I am a non-resident of Pakistan for this return."
            selected={residencyStatus === "non_resident"}
            onClick={() => onResidencyStatusChange("non_resident")}
          />
        </div>
      </div>
    );
  }

  if (currentStepKey === "readiness") {
    return (
      <div className="space-y-6">
        <StepHeading
          title="What do you already have ready?"
          description="Tap each card to confirm - everything here is needed to continue."
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {readinessOptions.map((item) => {
            const selected = readinessCompleted.includes(item.value);
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => onReadinessToggle(item.value)}
                className={`relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all ${selected ? "border-amanah bg-amanah/5 shadow-sm" : "border-border bg-card hover:border-amanah/35"}`}
              >
                {selected && (
                  <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-amanah text-white">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                )}
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-xl border ${selected ? "border-amanah/25 bg-amanah/10 text-amanah" : "border-border bg-muted/40 text-muted-foreground"}`}
                >
                  <item.icon className="h-5 w-5" />
                </span>
                <span
                  className={`text-xs font-medium ${selected ? "text-amanah" : "text-foreground"}`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StepHeading eyebrow="Setup complete" title="Review your answers" />
      <div className="flex flex-wrap gap-2">
        {filerType && (
          <span className="rounded-full border bg-card px-3 py-1.5 text-sm capitalize">
            {filerType.replaceAll("_", " ")}
          </span>
        )}
        {showStructureRow && (
          <span className="rounded-full border bg-card px-3 py-1.5 text-sm capitalize">
            {businessStructure?.replaceAll("_", " ")}
          </span>
        )}
        <span className="rounded-full border bg-card px-3 py-1.5 text-sm">
          Tax year {taxYear}
        </span>
        <span className="rounded-full border bg-card px-3 py-1.5 text-sm">
          {residencyStatus === "resident"
            ? "Resident"
            : residencyStatus === "non_resident"
              ? "Non-Resident"
              : "Residency not selected"}
        </span>
        {needsIncomeSourceSelection && (
          <span className="rounded-full border bg-card px-3 py-1.5 text-sm">
            {incomeSources.length} income source(s)
          </span>
        )}
        <span className="rounded-full border bg-card px-3 py-1.5 text-sm">
          {documentRequirementSummary}
        </span>
      </div>
      {currentStepKey === "review" && requiredDocumentLabels.length > 0 && (
        <div className="rounded-xl border bg-muted/20 p-4">
          <p className="text-sm font-semibold text-foreground">
            Required documents
          </p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {requiredDocumentLabels.map((label) => (
              <li key={label} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-amanah" />
                {label}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium ${routeToneClass}`}
      >
        <Route className="h-4 w-4" />
        {eligibilityRouteLabel}
      </div>
      {!canSubmit && (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          Some required answers are still missing.
        </div>
      )}
    </div>
  );
}
