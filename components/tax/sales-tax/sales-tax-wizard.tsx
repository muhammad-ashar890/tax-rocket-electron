"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Landmark,
  Loader2,
  Rocket,
} from "lucide-react";

import {
  approveSalesTaxReturnAction,
  getSalesTaxFilingAction,
  saveSalesTaxFiguresAction,
  saveSalesTaxProfileAction,
  startSalesTaxMonthAction,
  type SalesTaxInvoiceState,
  type SalesTaxReview,
} from "@/app/actions/sales-tax";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";
import { WizardShellLayout } from "@/components/tax/filing/wizard-shell-layout";
import {
  SelectableCard,
  StepHeading,
  type StepsRailItem,
} from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import {
  AUTHORITIES,
  EARLIEST_PERIOD_YEAR,
  formatPeriod,
  getAuthorityName,
  monthName,
  validateAuthoritySelection,
  validateBusinessDetails,
  validateRequestedPeriod,
} from "@/lib/sales-tax/profile";
import {
  emptyFiguresForm,
  figuresToForm,
  type FiguresForm,
} from "@/lib/sales-tax/figures";
import { formatRupees } from "@/lib/sales-tax/money";
import { cn } from "@/lib/utils";

import { FiguresStep } from "./figures-step";
import { formatIsoDate } from "./format";
import {
  CheckStep,
  EMPTY_INVOICES,
  UploadStep,
  invoiceBlockers,
  invoiceSummaryRows,
} from "./invoice-steps";
import { ReviewStep } from "./review-step";

type DueDates = { annexC: string; payment: string; returnFiling: string };

type Props = {
  initialProfile: {
    businessName: string;
    registrationNo: string;
    authorities: string[];
  } | null;
  /** "Today" as the server saw it, so the first render matches on both sides. */
  currentYear: number;
  currentMonth: number;
  /** Set when an existing month is reopened: the wizard resumes at the invoices. */
  existing?: {
    filingId: string;
    authority: string;
    year: number;
    month: number;
    dueDates: DueDates | null;
    invoices: SalesTaxInvoiceState;
    review: SalesTaxReview;
  } | null;
};

// The wizard has two parts in one screen, like the income-tax wizard: the
// setup questions, then (after "Create return") the invoice steps.
const SETUP_STEPS = [
  "Business details",
  "Authorities",
  "Return month",
  "Review",
] as const;
const INVOICE_STEPS = [
  "Sales invoices",
  "Purchase invoices",
  "Check problems",
] as const;
const FINAL_STEPS = ["Your figures", "Review return"] as const;
const REVIEW_STEP = SETUP_STEPS.length - 1;
const FIGURES_STEP = SETUP_STEPS.length + INVOICE_STEPS.length;
const APPROVE_STEP = FIGURES_STEP + 1;

/** Where a month is picked up: the review once approved, else after the last file. */
function resumeStep(
  invoices: SalesTaxInvoiceState,
  review: SalesTaxReview | null,
): number {
  if (review?.approval) return APPROVE_STEP;
  return (
    SETUP_STEPS.length + (invoices.sales ? (invoices.purchases ? 2 : 1) : 0)
  );
}

const inputClass =
  "h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:border-amanah focus:ring-2 focus:ring-amanah/20";

export function SalesTaxWizard({
  initialProfile,
  currentYear,
  currentMonth,
  existing = null,
}: Props) {
  // Default to the month that just ended: that is the return normally due.
  const previous = new Date(currentYear, currentMonth - 2, 1);

  const [filingId, setFilingId] = useState<string | null>(
    existing?.filingId ?? null,
  );
  const [dueDates, setDueDates] = useState<DueDates | null>(
    existing?.dueDates ?? null,
  );
  const [alreadyStarted, setAlreadyStarted] = useState(false);
  const [invoices, setInvoices] = useState<SalesTaxInvoiceState>(
    existing?.invoices ?? EMPTY_INVOICES,
  );

  // Steps are numbered across both parts: 0-3 setup, 4-6 invoices.
  const [step, setStep] = useState(() =>
    existing ? resumeStep(existing.invoices, existing.review) : 0,
  );
  const [review, setReview] = useState<SalesTaxReview | null>(
    existing?.review ?? null,
  );
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [figuresForm, setFiguresForm] = useState<FiguresForm>(() =>
    existing ? figuresToForm(existing.review.figures) : emptyFiguresForm(),
  );
  const [furthest, setFurthest] = useState(step);
  const [businessName, setBusinessName] = useState(
    initialProfile?.businessName ?? "",
  );
  const [registrationNo, setRegistrationNo] = useState(
    initialProfile?.registrationNo ?? "",
  );
  const [authorities, setAuthorities] = useState<string[]>(
    existing
      ? [existing.authority]
      : initialProfile?.authorities?.length
        ? initialProfile.authorities
        : ["FBR"],
  );
  const [year, setYear] = useState(existing?.year ?? previous.getFullYear());
  const [month, setMonth] = useState(
    existing?.month ?? previous.getMonth() + 1,
  );
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingBusiness, setEditingBusiness] = useState(false);

  const created = filingId !== null;
  const inInvoices =
    created && step >= SETUP_STEPS.length && step < FIGURES_STEP;
  const inFinal = created && step >= FIGURES_STEP;
  const invoiceStep = step - SETUP_STEPS.length;
  const approvedNow = review?.approval?.current === true;

  const today = useMemo(
    () => new Date(currentYear, currentMonth - 1, 15),
    [currentYear, currentMonth],
  );
  const years = useMemo(
    () =>
      Array.from(
        { length: currentYear - EARLIEST_PERIOD_YEAR + 1 },
        (_, index) => currentYear - index,
      ),
    [currentYear],
  );

  const business = validateBusinessDetails({ businessName, registrationNo });
  const authorityCheck = validateAuthoritySelection(authorities);
  const periodCheck = validateRequestedPeriod(year, month, today);

  const setupErrors: (string | null)[] = [
    business.ok === false ? business.error : null,
    authorityCheck.ok === false ? authorityCheck.error : null,
    periodCheck.ok === false ? periodCheck.error : null,
    null,
  ];
  const setupValid = setupErrors.every((error) => error === null);
  const periodLabel = periodCheck.ok ? formatPeriod(periodCheck.value) : "";

  // One rail for the whole wizard: the four setup steps, then the three
  // invoice steps. Once the return exists the setup steps stay ticked.
  const allSteps = [...SETUP_STEPS, ...INVOICE_STEPS, ...FINAL_STEPS];
  const railItems: StepsRailItem[] = allSteps.map((label, index) => {
    const current = editingBusiness ? index === 0 : index === step;
    const completed = created
      ? !current && index < Math.max(step, furthest)
      : !current &&
        index <= REVIEW_STEP &&
        index < Math.max(step, Math.min(furthest, REVIEW_STEP)) &&
        setupErrors[index] === null;
    return { label, completed, current };
  });

  const summaryRows = [
    {
      label: "Business",
      value: business.ok ? business.value.businessName : businessName.trim(),
    },
    { label: "STRN", value: business.ok ? business.value.registrationNo : "" },
    {
      label: "Authority",
      value:
        (step >= 1 || created) && authorityCheck.ok
          ? authorityCheck.value.map(getAuthorityName).join(", ")
          : "",
    },
    {
      label: "Return month",
      value: (step >= 2 || created) && periodCheck.ok ? periodLabel : "",
    },
    ...(created && dueDates
      ? [
          { label: "Annex-C due", value: formatIsoDate(dueDates.annexC) },
          { label: "Payment due", value: formatIsoDate(dueDates.payment) },
          { label: "Return due", value: formatIsoDate(dueDates.returnFiling) },
        ]
      : []),
    ...(created ? invoiceSummaryRows(invoices) : []),
    ...(step >= APPROVE_STEP && review?.estimate.canEstimate
      ? [
          {
            label: "Estimated payable",
            value: formatRupees(review.estimate.balancePayable ?? 0),
          },
          { label: "Approved", value: approvedNow ? "Yes" : "Not yet" },
        ]
      : []),
  ];

  function finalBlockers(): string[] {
    if (step === FIGURES_STEP) {
      return [
        "Fill in what applies to you, then continue to see your estimate.",
      ];
    }
    if (!review) return [];
    if (!review.estimate.canEstimate) {
      return [
        "The estimate cannot be prepared yet. Read the message on this step.",
      ];
    }
    if (approvedNow) return [];
    return reviewed
      ? []
      : ["Tick the box to confirm that you have reviewed the return."];
  }

  const blockers = inInvoices
    ? invoiceBlockers(invoices, invoiceStep)
    : inFinal
      ? finalBlockers()
      : setupErrors[step]
        ? [setupErrors[step] as string]
        : [];

  function moveTo(next: number) {
    setStep(next);
    setFurthest((value) => Math.max(value, next));
  }

  /** Loads the saved month again so the review shows the files as they are now. */
  async function refreshReview() {
    if (!filingId) return;
    setReviewLoading(true);
    try {
      const loaded = await getSalesTaxFilingAction(filingId);
      if (loaded.success) {
        setInvoices(loaded.invoices);
        setReview(loaded.review);
      } else {
        setActionError(loaded.error);
      }
    } catch {
      setActionError("Could not prepare your estimate. Please try again.");
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleSaveFigures() {
    if (!filingId || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const saved = await saveSalesTaxFiguresAction(filingId, figuresForm);
      if (saved.success === false) {
        setActionError(saved.error);
        return;
      }
      setReview(saved.review);
      setReviewed(false);
      moveTo(APPROVE_STEP);
    } catch {
      setActionError("Could not save your figures. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove() {
    if (!filingId || submitting || !reviewed) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const approved = await approveSalesTaxReturnAction(filingId, reviewed);
      if (approved.success === false) {
        setActionError(approved.error);
        return;
      }
      setReview(approved.review);
      setReviewed(false);
    } catch {
      setActionError("Could not approve this return. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function goNext() {
    setActionError(null);
    if (step < SETUP_STEPS.length && setupErrors[step] !== null) {
      setTouched(true);
      return;
    }
    setTouched(false);
    if (created && step === FIGURES_STEP) {
      void handleSaveFigures();
      return;
    }
    const last = created ? APPROVE_STEP : REVIEW_STEP;
    moveTo(Math.min(step + 1, last));
  }

  function goBack() {
    setActionError(null);
    setTouched(false);
    setStep((value) => Math.max(value - 1, created ? SETUP_STEPS.length : 0));
  }

  function toggleAuthority(code: string) {
    setAuthorities((current) =>
      current.includes(code)
        ? current.filter((item) => item !== code)
        : [...current, code],
    );
  }

  async function handleCreate() {
    if (!setupValid || submitting) return;
    if (!business.ok || !authorityCheck.ok || !periodCheck.ok) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const saved = await saveSalesTaxProfileAction({
        businessName: business.value.businessName,
        registrationNo: business.value.registrationNo,
        authorities: authorityCheck.value,
      });
      if (!saved.success) {
        setActionError(saved.error);
        return;
      }
      // One return per authority; the first selected authority is started
      // here. Further authorities arrive with their own phases.
      const started = await startSalesTaxMonthAction({
        authority: authorityCheck.value[0],
        year: periodCheck.value.year,
        month: periodCheck.value.month,
      });
      if (!started.success) {
        setActionError(started.error);
        return;
      }
      // Load the month as it is stored (an existing month may have files),
      // then carry on with the invoice steps on this same screen. The address
      // is left alone on purpose: changing it would reload the page.
      const loaded = await getSalesTaxFilingAction(started.id);
      if (!loaded.success) {
        setActionError(loaded.error);
        return;
      }
      setInvoices(loaded.invoices);
      setReview(loaded.review);
      setFiguresForm(figuresToForm(loaded.review.figures));
      setDueDates(loaded.filing.dueDates);
      setAlreadyStarted(started.alreadyExisted);
      setFilingId(started.id);
      const next = resumeStep(loaded.invoices, loaded.review);
      setStep(next);
      setFurthest(next);
    } catch {
      setActionError(
        "Something went wrong while creating your return. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** Saves corrected business details of a return that already exists. */
  async function handleSaveBusiness() {
    if (!business.ok || !filingId || submitting) {
      setTouched(true);
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      const saved = await saveSalesTaxProfileAction({
        businessName: business.value.businessName,
        registrationNo: business.value.registrationNo,
        // Keep the saved authorities; they are fixed once a return exists.
        authorities: authorityCheck.ok ? authorityCheck.value : ["FBR"],
      });
      if (!saved.success) {
        setActionError(saved.error);
        return;
      }
      // The checks compare the file with the registration number, so run
      // them again against the corrected number.
      const loaded = await getSalesTaxFilingAction(filingId);
      if (loaded.success) {
        setInvoices(loaded.invoices);
        setReview(loaded.review);
      }
      setEditingBusiness(false);
      setTouched(false);
    } catch {
      setActionError("Could not save your business details. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function renderBusiness() {
    return (
      <div className="space-y-6">
        <StepHeading
          eyebrow={editingBusiness ? "Business details" : "Step 1"}
          title="Tell us about your business"
          description="Use the details on your sales tax registration certificate."
        />
        <div className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            Business name
            <input
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              placeholder="e.g. Technexia Traders"
              maxLength={120}
              autoComplete="organization"
              className={inputClass}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            Sales tax registration number (STRN)
            <input
              value={registrationNo}
              onChange={(event) => setRegistrationNo(event.target.value)}
              placeholder="e.g. 3277876123456"
              inputMode="numeric"
              maxLength={30}
              className={inputClass}
            />
            <span className="block text-xs font-normal text-muted-foreground">
              Digits, dashes and spaces are fine. We keep it for your records
              and to cross-check your invoices.
            </span>
          </label>
        </div>
      </div>
    );
  }

  function renderAuthorities() {
    return (
      <div className="space-y-6">
        <StepHeading
          eyebrow="Step 2"
          title="Where do you file sales tax?"
          description="Goods are filed with FBR and services with the provincial boards. Each authority has its own return."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {AUTHORITIES.map((authority) =>
            authority.enabled ? (
              <SelectableCard
                key={authority.code}
                icon={Landmark}
                label={authority.name}
                hint={authority.scope}
                selected={authorities.includes(authority.code)}
                onClick={() => toggleAuthority(authority.code)}
              />
            ) : (
              <div
                key={authority.code}
                aria-disabled="true"
                className="flex items-start gap-3 rounded-xl border border-dashed bg-muted/20 p-3.5 text-sm opacity-70"
              >
                <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground">
                  <Landmark className="h-[18px] w-[18px]" />
                </span>
                <span className="flex-1">
                  <span className="block font-medium text-muted-foreground">
                    {authority.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {authority.scope} · Coming soon
                  </span>
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    );
  }

  function renderMonth() {
    return (
      <div className="space-y-6">
        <StepHeading
          eyebrow="Step 3"
          title="Which month is this return for?"
          description="Pick the month your invoices belong to. The month that just ended is selected for you."
        />
        <div className="space-y-2">
          <span className="text-sm font-medium text-foreground">Year</span>
          <div className="flex flex-wrap gap-2">
            {years.slice(0, 6).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setYear(value)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  year === value
                    ? "border-amanah bg-amanah text-white shadow-sm"
                    : "border-border bg-card text-foreground hover:border-amanah/40",
                )}
              >
                {value}
              </button>
            ))}
            {years.length > 6 && (
              <select
                aria-label="Earlier years"
                value={years.slice(0, 6).includes(year) ? "" : String(year)}
                onChange={(event) => {
                  if (event.target.value) setYear(Number(event.target.value));
                }}
                className="rounded-full border bg-card px-3 py-2 text-sm"
              >
                <option value="">Earlier…</option>
                {years.slice(6).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium text-foreground">Month</span>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
            {Array.from({ length: 12 }, (_, index) => index + 1).map(
              (value) => {
                const future =
                  year > currentYear ||
                  (year === currentYear && value > currentMonth);
                const selected = month === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={future}
                    onClick={() => setMonth(value)}
                    className={cn(
                      "relative rounded-xl border-2 px-3 py-3 text-sm font-medium transition-all duration-150",
                      selected
                        ? "border-amanah bg-amanah/5 text-amanah shadow-sm"
                        : "border-border bg-card text-foreground hover:border-amanah/35 hover:shadow-sm",
                      future &&
                        "cursor-not-allowed opacity-40 hover:border-border hover:shadow-none",
                    )}
                  >
                    {selected && (
                      <span className="absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-amanah text-white">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                    {monthName(value)}
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderReview() {
    const rows: { label: string; value: string }[] = [
      {
        label: "Business",
        value: business.ok ? business.value.businessName : "",
      },
      {
        label: "STRN",
        value: business.ok ? business.value.registrationNo : "",
      },
      {
        label: "Authority",
        value: authorityCheck.ok
          ? authorityCheck.value.map(getAuthorityName).join(", ")
          : "",
      },
      { label: "Return month", value: periodLabel },
    ];
    return (
      <div className="space-y-6">
        <StepHeading
          eyebrow="Step 4"
          title="Check and create your return"
          description="Make sure these details are right. You can go back and change any of them."
        />
        <dl className="divide-y rounded-xl border bg-card">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-start justify-between gap-4 px-4 py-3 text-sm"
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right font-medium text-foreground">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="rounded-xl border border-amanah/20 bg-amanah/5 p-3 text-sm text-foreground">
          This creates a draft return for the month. Nothing is filed with FBR.
          Next, you will upload your sales and purchase invoices.
        </p>
      </div>
    );
  }

  function renderStep() {
    if (editingBusiness) return renderBusiness();
    if ((inInvoices || inFinal) && filingId) {
      if (inFinal) {
        if (step === FIGURES_STEP) {
          return (
            <FiguresStep
              stepNumber={step + 1}
              form={figuresForm}
              onChange={setFiguresForm}
            />
          );
        }
        return (
          <ReviewStep
            stepNumber={step + 1}
            review={review}
            loading={reviewLoading}
            paymentDue={dueDates?.payment ?? null}
            reviewed={reviewed}
            onReviewed={setReviewed}
          />
        );
      }
      if (invoiceStep === 2) {
        return (
          <CheckStep invoices={invoices} stepNumber={SETUP_STEPS.length + 3} />
        );
      }
      return (
        <UploadStep
          key={invoiceStep}
          filingId={filingId}
          kind={invoiceStep === 0 ? "SALES" : "PURCHASES"}
          stepNumber={step + 1}
          invoices={invoices}
          onInvoices={setInvoices}
          onError={setActionError}
        />
      );
    }
    return [renderBusiness, renderAuthorities, renderMonth, renderReview][
      step
    ]();
  }

  const businessError = setupErrors[0];

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TaxRocketLogo showWordmark={false} />
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              {existing
                ? `Sales tax return · ${periodLabel}`
                : "New sales tax return"}
            </h1>
            <p className="text-xs text-muted-foreground">
              One simple question at a time.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
          >
            <Link href="/tax/sales-tax">
              {created ? "All returns" : "Cancel"}
            </Link>
          </Button>
        </div>
      </div>

      <WizardShellLayout
        showRail
        railItems={railItems}
        summaryRows={summaryRows}
        blockers={editingBusiness && businessError ? [businessError] : blockers}
        onRailItemClick={(index) => {
          setActionError(null);
          if (created) {
            // The return exists: its month and authority are fixed. The first
            // step reopens the business details so a wrong STRN can be fixed.
            if (index === 0) {
              setEditingBusiness(true);
              return;
            }
            if (index < SETUP_STEPS.length) return;
            // The last two steps open only after the ones before them.
            if (index >= FIGURES_STEP && index > furthest) return;
          } else if (index > REVIEW_STEP) {
            return;
          }
          setEditingBusiness(false);
          setStep(index);
          if (created && index === APPROVE_STEP) void refreshReview();
        }}
      >
        {alreadyStarted && inInvoices && (
          <p className="mb-6 rounded-lg border border-amanah/20 bg-amanah/5 p-3 text-sm text-foreground">
            You had already started this month, so we opened it instead of
            creating a second one.
          </p>
        )}
        {actionError && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {actionError}
          </div>
        )}

        <div
          key={editingBusiness ? "business" : step}
          className="animate-in fade-in slide-in-from-right-2 duration-300"
        >
          {renderStep()}
        </div>

        {touched &&
          (editingBusiness
            ? businessError
            : step < SETUP_STEPS.length && setupErrors[step]) && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {editingBusiness ? businessError : setupErrors[step]}
            </p>
          )}

        <div className="sticky bottom-0 z-10 mt-8 flex items-center justify-between gap-3 border-t border-border bg-background/95 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          {editingBusiness ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  setEditingBusiness(false);
                  setTouched(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleSaveBusiness}
                disabled={submitting}
                className="gap-2"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Save changes
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={goBack}
                disabled={
                  step === 0 ||
                  (created && step === SETUP_STEPS.length) ||
                  submitting
                }
                className="gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              {!created && step === REVIEW_STEP ? (
                <Button
                  type="button"
                  onClick={handleCreate}
                  disabled={submitting || !setupValid}
                  className="gap-2"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4" />
                  )}
                  Create return
                </Button>
              ) : created && step === APPROVE_STEP ? (
                approvedNow ? (
                  <Button asChild variant="outline">
                    <Link href="/tax/sales-tax">Back to your returns</Link>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={handleApprove}
                    disabled={
                      submitting ||
                      reviewLoading ||
                      !reviewed ||
                      !review?.estimate.canEstimate
                    }
                    className="gap-2"
                  >
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    Approve return
                  </Button>
                )
              ) : (
                <Button
                  type="button"
                  onClick={goNext}
                  disabled={submitting}
                  className="gap-2"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {created && step === FIGURES_STEP
                    ? "See my estimate"
                    : "Continue"}
                  {!submitting && <ArrowRight className="h-4 w-4" />}
                </Button>
              )}
            </>
          )}
        </div>
      </WizardShellLayout>
    </div>
  );
}
