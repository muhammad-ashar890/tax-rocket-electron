"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Banknote,
  CheckCircle2,
  Maximize2,
  Minimize2,
  PenLine,
  Plus,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";

import { getBankAccountsAction } from "@/app/actions/bank-accounts";
import {
  autoReviewSafeBankTransactionsAction,
  classifyBankTransactionsAction,
  manuallyClassifyBankTransactionAction,
  reviewBankTransactionClassificationAction,
  undoBankTransactionClassificationAction,
  validateBankTransactionReviewAction,
} from "@/app/actions/bank-classification";
import {
  getAllBankStatementsAction,
  saveBankStatementAction,
} from "@/app/actions/bank-statements";
import {
  addBankTransactionAction,
  getBankTransactionsAction,
} from "@/app/actions/bank-transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";
import { getTaxYearDateInputBounds } from "@/lib/tax/tax-year-period";

type BankAccountSummary = {
  id: string;
  bankName: string;
  accountLabel: string;
  accountNumberMasked: string | null;
  currency: string;
};

type BankStatementSummary = {
  id: string;
  bankAccountId: string | null;
  accountLabel: string;
  accountNumberMasked: string | null;
  currency: string;
  openingBalance: number;
  closingBalance: number;
  periodStart: string;
  periodEnd: string;
  bankAccount?: {
    bankName: string;
    accountLabel: string;
  } | null;
};

type BankRow = {
  id?: string;
  bankAccountId?: string | null;
  bankStatementId?: string | null;
  date: string;
  description: string;
  bankName?: string | null;
  accountLabel?: string | null;
  debit: string;
  credit: string;
  balance: string;
  source?: string;
  classificationStatus?: string;
  suggestedEntryType?: string | null;
  suggestedCategory?: string | null;
};

type WizardBankIntelligenceStepProps = Readonly<{
  draftId?: string;
  taxYear: number;
  onReviewStateChange?: (ready: boolean) => void;
  onClassificationStateChange?: (classified: boolean) => void;
  onStatementSavedChange?: (saved: boolean) => void;
  onBankDataChanged?: () => void;
}>;

function formatSuggestionPart(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

export function WizardBankIntelligenceStep({
  draftId,
  taxYear,
  onReviewStateChange,
  onClassificationStateChange,
  onStatementSavedChange,
  onBankDataChanged,
}: WizardBankIntelligenceStepProps) {
  const [rows, setRows] = useState<BankRow[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccountSummary[]>([]);
  const [bankStatements, setBankStatements] = useState<BankStatementSummary[]>(
    [],
  );
  const [statementsValid, setStatementsValid] = useState(false);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [rowDraft, setRowDraft] = useState<BankRow>({
    date: "",
    description: "",
    debit: "",
    credit: "",
    balance: "",
  });
  const [openingBalance, setOpeningBalance] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [statementSaved, setStatementSaved] = useState(false);
  const [isFullView, setIsFullView] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [manualReviewId, setManualReviewId] = useState<string | null>(null);
  const [manualReviewPosition, setManualReviewPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [manualEntryType, setManualEntryType] = useState<
    "INCOME" | "EXPENSE" | "ASSET" | "LIABILITY" | "EXCLUDE"
  >("EXPENSE");
  const [manualCategory, setManualCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function closeManualReview(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (
        target.closest("[data-manual-review-panel]") ||
        target.closest("[data-manual-review-trigger]")
      ) {
        return;
      }
      setManualReviewId(null);
    }

    document.addEventListener("mousedown", closeManualReview);
    return () => document.removeEventListener("mousedown", closeManualReview);
  }, []);

  useEffect(() => {
    if (error) {
      errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [error]);

  const taxYearBounds = getTaxYearDateInputBounds(taxYear);
  const manualCategoryOptions = {
    INCOME: [
      "SALARY",
      "PENSION",
      "BANK_PROFIT",
      "PROPERTY_RENT",
      "DIVIDEND",
      "SERVICES",
      "OTHER_INCOME",
    ],
    EXPENSE: [
      "PERSONAL_EXPENSE",
      "UTILITIES_OR_RENT",
      "TRANSPORT",
      "BANK_CHARGES",
      "TAX_PAYMENT",
      "OTHER_EXPENSE",
    ],
    ASSET: ["PROPERTY", "VEHICLE", "EQUIPMENT", "INVESTMENT", "OTHER_ASSET"],
    LIABILITY: ["LOAN_PROCEEDS", "CREDIT_CARD", "OTHER_LIABILITY"],
    EXCLUDE: [],
  } as const;

  const manualReviewPanel =
    typeof document !== "undefined" && manualReviewId && manualReviewPosition
      ? createPortal(
          <div
            data-manual-review-panel
            className="grid w-48 gap-2 rounded-md border bg-background p-2 text-left shadow-lg"
            style={{
              position: "fixed",
              top: manualReviewPosition.top,
              left: manualReviewPosition.left,
              zIndex: 10000,
            }}
          >
            <select
              value={manualEntryType}
              onChange={(event) =>
                setManualEntryType(
                  event.target.value as
                    | "INCOME"
                    | "EXPENSE"
                    | "ASSET"
                    | "LIABILITY"
                    | "EXCLUDE",
                )
              }
              className="h-8 w-full rounded border bg-background px-2 text-xs"
            >
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
              <option value="ASSET">Asset</option>
              <option value="LIABILITY">Liability</option>
            </select>
            {manualEntryType !== "EXCLUDE" && (
              <select
                value={manualCategory}
                onChange={(event) => setManualCategory(event.target.value)}
                className="h-8 w-full rounded border bg-background px-2 text-xs"
              >
                <option value="">Select category</option>
                {manualCategoryOptions[manualEntryType].map((category) => (
                  <option key={category} value={category}>
                    {formatSuggestionPart(category)}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => handleManualClassification(manualReviewId)}
              disabled={reviewingId === manualReviewId}
              className="rounded bg-amanah px-2 py-1 text-xs font-medium text-white hover:bg-amanah/90"
            >
              {reviewingId === manualReviewId ? "Saving..." : "Save decision"}
            </button>
          </div>,
          document.body,
        )
      : null;

  function updateReviewState(nextRows: BankRow[]) {
    const ready = nextRows.every(
      (row) =>
        row.classificationStatus === "APPROVED" ||
        row.classificationStatus === "REJECTED" ||
        row.classificationStatus === "TRANSFER" ||
        row.classificationStatus === "CASH_MOVEMENT",
    );
    onReviewStateChange?.(ready);
    return ready;
  }

  async function refreshData() {
    if (!draftId) return;

    const [transactions, accountsResult, statementsResult] = await Promise.all([
      getBankTransactionsAction(draftId),
      getBankAccountsAction(draftId),
      getAllBankStatementsAction(draftId),
    ]);

    if (transactions.success) {
      const nextRows = transactions.rows as BankRow[];
      setRows(nextRows);
      const locallyReviewed = updateReviewState(nextRows);
      if (locallyReviewed) {
        const reviewValidation =
          await validateBankTransactionReviewAction(draftId);
        onReviewStateChange?.(reviewValidation.success);
        if (!reviewValidation.success) {
          setError(
            reviewValidation.error ??
              "Bank transaction decisions are not internally consistent.",
          );
        }
      }
      // A classification run is complete once the system has produced at
      // least one classification decision. Unknown rows may remain
      // UNREVIEWED and can be handled later as transfers/cash movements.
      onClassificationStateChange?.(
        nextRows.length === 0 ||
          nextRows.some((row) => row.classificationStatus !== "UNREVIEWED"),
      );
    }

    const nextAccounts = (accountsResult.accounts ??
      []) as BankAccountSummary[];
    setBankAccounts(nextAccounts);
    setSelectedBankAccountId((current) =>
      nextAccounts.some((account) => account.id === current)
        ? current
        : (nextAccounts[0]?.id ?? ""),
    );

    const nextStatements = (statementsResult.statements ??
      []) as BankStatementSummary[];
    setBankStatements(nextStatements);
    setStatementsValid(Boolean(statementsResult.success));
    const allAccountsSaved =
      accountsResult.success &&
      statementsResult.success &&
      nextAccounts.length > 0 &&
      nextAccounts.every((account) =>
        nextStatements.some(
          (statement) => statement.bankAccountId === account.id,
        ),
      );
    onStatementSavedChange?.(allAccountsSaved);

    if (!accountsResult.success) {
      setError(accountsResult.error ?? "Failed to fetch bank accounts");
    } else if (!statementsResult.success) {
      setError(
        statementsResult.error ?? "Bank statement does not match this tax year",
      );
    }
  }

  useEffect(() => {
    void refreshData();
  }, [draftId]);

  useEffect(() => {
    const selectedStatement = bankStatements.find(
      (statement) => statement.bankAccountId === selectedBankAccountId,
    );
    setOpeningBalance(
      selectedStatement ? String(selectedStatement.openingBalance) : "",
    );
    setClosingBalance(
      selectedStatement ? String(selectedStatement.closingBalance) : "",
    );
    setPeriodStart(selectedStatement?.periodStart ?? "");
    setPeriodEnd(selectedStatement?.periodEnd ?? "");
    setStatementSaved(Boolean(selectedStatement));
    onStatementSavedChange?.(
      statementsValid &&
        bankAccounts.length > 0 &&
        bankAccounts.every((account) =>
          bankStatements.some(
            (statement) => statement.bankAccountId === account.id,
          ),
        ),
    );
  }, [bankAccounts, bankStatements, selectedBankAccountId, statementsValid]);

  const selectedBankAccount = bankAccounts.find(
    (account) => account.id === selectedBankAccountId,
  );
  const selectedRows = rows.filter(
    (row) => row.bankAccountId === selectedBankAccountId,
  );
  const allAccountsSaved =
    statementsValid &&
    bankAccounts.length > 0 &&
    bankAccounts.every((account) =>
      bankStatements.some(
        (statement) => statement.bankAccountId === account.id,
      ),
    );

  async function handleSaveStatement() {
    if (!draftId || !selectedBankAccountId) return;
    setSaving(true);
    setError(null);
    setStatementSaved(false);
    onStatementSavedChange?.(false);

    const result = await saveBankStatementAction(draftId, {
      bankAccountId: selectedBankAccountId,
      openingBalance: Number(openingBalance),
      closingBalance: Number(closingBalance),
      periodStart,
      periodEnd,
    });
    setSaving(false);

    if (!result.success) {
      setError(result.error ?? "Failed to save statement balances");
      return;
    }

    onBankDataChanged?.();
    await refreshData();
  }

  async function handleAddRow() {
    if (!draftId || !selectedBankAccountId) return;
    if (
      !rowDraft.date ||
      !rowDraft.description ||
      (!rowDraft.debit && !rowDraft.credit)
    ) {
      setError("Date, description, and debit or credit are required");
      return;
    }

    setSaving(true);
    setError(null);
    const result = await addBankTransactionAction(
      draftId,
      selectedBankAccountId,
      rowDraft,
    );
    setSaving(false);

    if (!result.success) {
      setError(result.error ?? "Failed to add transaction");
      return;
    }

    setRowDraft({
      date: "",
      description: "",
      debit: "",
      credit: "",
      balance: "",
    });
    onBankDataChanged?.();
    await refreshData();
    // The new row is unclassified. Keep Continue blocked even when older
    // rows already have persisted classification decisions.
    onClassificationStateChange?.(false);
  }

  async function handleClassify() {
    if (!draftId || !selectedBankAccountId || selectedRows.length === 0) return;
    setClassifying(true);
    setError(null);
    const result = await classifyBankTransactionsAction(draftId, {
      bankAccountId: selectedBankAccountId,
      openingBalance: Number(openingBalance),
      closingBalance: Number(closingBalance),
      periodStart,
      periodEnd,
    });
    setClassifying(false);
    if (!result.success) {
      setError(result.error ?? "Failed to classify transactions");
      return;
    }
    onBankDataChanged?.();
    await refreshData();
    onClassificationStateChange?.(true);
  }

  async function handleAutoReviewSafe() {
    if (!draftId || !selectedBankAccountId) return;
    setClassifying(true);
    setError(null);
    const result = await autoReviewSafeBankTransactionsAction(
      draftId,
      selectedBankAccountId,
    );
    setClassifying(false);
    if (!result.success) {
      setError(result.error ?? "Failed to auto-review safe transactions");
      return;
    }
    onBankDataChanged?.();
    await refreshData();
  }

  async function handleManualClassification(id: string) {
    setReviewingId(id);
    setError(null);
    const result = await manuallyClassifyBankTransactionAction(
      draftId!,
      id,
      manualEntryType,
      manualCategory,
    );
    setReviewingId(null);
    if (!result.success) {
      setError(result.error ?? "Failed to save manual classification");
      return;
    }
    setManualReviewId(null);
    setManualCategory("");
    onBankDataChanged?.();
    await refreshData();
  }

  async function handleUndo(id: string) {
    if (!draftId) return;
    setReviewingId(id);
    setError(null);
    const result = await undoBankTransactionClassificationAction(draftId, id);
    setReviewingId(null);
    if (!result.success) {
      setError(result.error ?? "Failed to undo classification");
      return;
    }
    onBankDataChanged?.();
    await refreshData();
  }

  async function handleReview(
    id: string,
    decision: "APPROVE" | "REJECT" | "TRANSFER" | "CASH_MOVEMENT",
  ) {
    if (!draftId) return;
    setReviewingId(id);
    setError(null);
    const result = await reviewBankTransactionClassificationAction(
      draftId,
      id,
      decision,
    );
    setReviewingId(null);
    if (!result.success) {
      setError(result.error ?? "Failed to review suggestion");
      return;
    }
    onBankDataChanged?.();
    await refreshData();
  }

  return (
    <div className="space-y-6">
      {manualReviewPanel}
      <StepHeading
        title="Bank Intelligence"
        description="Confirm statement balances and review transactions before they feed your ledgers."
      />

      {error &&
        !error.toLowerCase().includes("date must fall within tax year") && (
          <div
            ref={errorRef}
            role="alert"
            className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
      {error &&
        error.toLowerCase().includes("date must fall within tax year") && (
          <div ref={errorRef} className="sr-only" aria-hidden>
            {error}
          </div>
        )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Selected account transactions"
          value={String(selectedRows.length)}
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Opening balance"
          value={
            openingBalance
              ? `${selectedBankAccount?.currency ?? "PKR"} ${Number(openingBalance).toLocaleString()}`
              : "Not set"
          }
        />
        <WorkflowKpiCard
          label="Closing balance"
          value={
            closingBalance
              ? `${selectedBankAccount?.currency ?? "PKR"} ${Number(closingBalance).toLocaleString()}`
              : "Not set"
          }
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Status"
          value={
            saving
              ? "Saving..."
              : allAccountsSaved
                ? "All accounts ready"
                : statementSaved
                  ? "Selected account ready"
                  : "Save required"
          }
        />
      </WorkflowKpiStrip>

      {bankAccounts.length > 0 ? (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div>
              <h3 className="text-sm font-semibold">Account being edited</h3>
              <p className="text-xs text-muted-foreground">
                Statement balances, manual rows and classification below apply
                only to the selected account.
              </p>
            </div>
            <div className="rounded-xl border-2 border-amanah/30 bg-amanah/5 p-3 shadow-sm">
              <label
                htmlFor="bank-intelligence-account"
                className="mb-2 flex items-center justify-between gap-3"
              >
                <span className="text-xs font-semibold text-amanah">
                  Select bank account to edit
                </span>
                <Badge className="bg-amanah text-white hover:bg-amanah">
                  Account selector
                </Badge>
              </label>
              <select
                id="bank-intelligence-account"
                aria-label="Select bank account to edit"
                value={selectedBankAccountId}
                onChange={(event) => {
                  setSelectedBankAccountId(event.target.value);
                  setError(null);
                }}
                className="h-11 w-full cursor-pointer rounded-lg border-2 border-amanah/40 bg-background px-3 text-sm font-semibold text-foreground shadow-sm transition focus:border-amanah focus:outline-none focus:ring-2 focus:ring-amanah/20"
              >
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.bankName} — {account.accountLabel}
                    {account.accountNumberMasked
                      ? ` (${account.accountNumberMasked})`
                      : ""}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Switching this selection changes the statement and transaction
                rows being edited below.
              </p>
            </div>

            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-xs font-semibold">Statement readiness</h4>
                <Badge variant="outline">
                  {
                    bankAccounts.filter((account) =>
                      bankStatements.some(
                        (statement) => statement.bankAccountId === account.id,
                      ),
                    ).length
                  }
                  /{bankAccounts.length} saved
                </Badge>
              </div>
              {bankAccounts.map((account) => {
                const statement = bankStatements.find(
                  (candidate) => candidate.bankAccountId === account.id,
                );
                return (
                  <div
                    key={account.id}
                    className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-[1.5fr_1fr_1fr]"
                  >
                    <span className="font-medium">
                      {account.bankName} — {account.accountLabel}
                    </span>
                    <span>
                      {statement
                        ? `Opening: ${account.currency} ${statement.openingBalance.toLocaleString()}`
                        : "Statement not saved"}
                    </span>
                    <span>
                      {statement
                        ? `Closing: ${account.currency} ${statement.closingBalance.toLocaleString()}`
                        : "Select this account to complete it"}
                    </span>
                  </div>
                );
              })}
              {bankStatements.length > 0 && (
                <div className="grid gap-2 border-t pt-3 text-sm font-semibold sm:grid-cols-[1.5fr_1fr_1fr]">
                  <span>Combined PKR statements</span>
                  <span>
                    Opening: PKR{" "}
                    {bankStatements
                      .filter((statement) => statement.currency === "PKR")
                      .reduce(
                        (total, statement) => total + statement.openingBalance,
                        0,
                      )
                      .toLocaleString()}
                  </span>
                  <span>
                    Closing: PKR{" "}
                    {bankStatements
                      .filter((statement) => statement.currency === "PKR")
                      .reduce(
                        (total, statement) => total + statement.closingBalance,
                        0,
                      )
                      .toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Configure at least one bank account before editing Bank Intelligence.
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-semibold">Statement balances</h3>
            <p className="text-xs text-muted-foreground">
              Use the actual balances printed on the bank statement.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex h-10 items-center rounded-lg border bg-muted/30 px-3 text-sm font-medium">
              {selectedBankAccount
                ? `${selectedBankAccount.bankName} — ${selectedBankAccount.accountLabel}`
                : "Select a bank account"}
            </div>
            <input
              value={openingBalance}
              onChange={(e) => {
                setOpeningBalance(e.target.value);
                setStatementSaved(false);
                onStatementSavedChange?.(false);
              }}
              type="number"
              placeholder="Opening balance"
              className="h-10 rounded-lg border px-3 text-sm"
            />
            <input
              value={closingBalance}
              onChange={(e) => {
                setClosingBalance(e.target.value);
                setStatementSaved(false);
                onStatementSavedChange?.(false);
              }}
              type="number"
              placeholder="Closing balance"
              className="h-10 rounded-lg border px-3 text-sm"
            />
            <div className="flex gap-2">
              <input
                value={periodStart}
                min={taxYearBounds.min}
                max={taxYearBounds.max}
                onChange={(e) => {
                  setPeriodStart(e.target.value);
                  setStatementSaved(false);
                  onStatementSavedChange?.(false);
                }}
                type="date"
                className="h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm"
              />
              <input
                value={periodEnd}
                min={taxYearBounds.min}
                max={taxYearBounds.max}
                onChange={(e) => {
                  setPeriodEnd(e.target.value);
                  setStatementSaved(false);
                  onStatementSavedChange?.(false);
                }}
                type="date"
                className="h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm"
              />
            </div>
          </div>
          <Button
            type="button"
            onClick={handleSaveStatement}
            disabled={
              saving || !draftId || !selectedBankAccountId || statementSaved
            }
          >
            {saving
              ? "Saving..."
              : statementSaved
                ? "Statement Saved"
                : "Save Statement Balances"}
          </Button>
        </CardContent>
      </Card>

      {isFullView && (
        <div
          className="fixed inset-0 bg-black/40"
          style={{ zIndex: 9998 }}
          onClick={() => setIsFullView(false)}
          aria-hidden="true"
        />
      )}
      <Card
        className={
          isFullView ? "overflow-auto rounded-none shadow-2xl" : "relative"
        }
        style={
          isFullView
            ? {
                position: "fixed",
                inset: 0,
                zIndex: 9999,
                margin: 0,
              }
            : undefined
        }
      >
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-semibold">Transactions</h3>
              <p className="text-xs text-muted-foreground">
                Green check = approve · blue arrows = internal transfer ·
                banknote = cash movement · amber X = exclude from ledger.
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center justify-start gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsFullView((current) => !current)}
                className={`gap-2 ${
                  isFullView
                    ? "border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 hover:text-orange-800"
                    : "border-amanah/35 bg-amanah/5 text-amanah hover:bg-amanah/10"
                }`}
              >
                {isFullView ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
                {isFullView ? "Exit Full View" : "Open Full View"}
              </Button>
              {selectedRows.some(
                (row) => row.classificationStatus === "SUGGESTED",
              ) && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAutoReviewSafe}
                  disabled={classifying || saving || !statementSaved}
                  className="gap-2 bg-amanah text-white hover:bg-amanah/90"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Approve All Safe Transactions
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={handleClassify}
                disabled={
                  classifying ||
                  saving ||
                  selectedRows.length === 0 ||
                  !statementSaved
                }
                className="gap-2"
              >
                <Sparkles className="h-4 w-4" />
                {classifying ? "Classifying..." : "Classify"}
              </Button>
              {!statementSaved && (
                <span className="text-[11px] text-muted-foreground">
                  Save statement balances before classifying.
                </span>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Date
                </label>
                <input
                  type="date"
                  min={taxYearBounds.min}
                  max={taxYearBounds.max}
                  value={rowDraft.date}
                  onChange={(e) =>
                    setRowDraft((p) => ({ ...p, date: e.target.value }))
                  }
                  className={`h-10 rounded-lg border bg-background px-3 text-sm ${error && error.toLowerCase().includes("date must fall within tax year") ? "border-destructive ring-1 ring-destructive/20" : ""}`}
                />
                {error &&
                  error
                    .toLowerCase()
                    .includes("date must fall within tax year") && (
                    <span className="text-[11px] leading-tight text-destructive">
                      Must be within {taxYearBounds.min} to {taxYearBounds.max}
                    </span>
                  )}
              </div>
              <div className="grid gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Description
                </label>
                <input
                  value={rowDraft.description}
                  onChange={(e) =>
                    setRowDraft((p) => ({ ...p, description: e.target.value }))
                  }
                  placeholder="Description"
                  className="h-10 rounded-lg border bg-background px-3 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Debit
                </label>
                <input
                  value={rowDraft.debit}
                  onChange={(e) =>
                    setRowDraft((p) => ({ ...p, debit: e.target.value }))
                  }
                  type="number"
                  placeholder="Debit"
                  className="h-10 rounded-lg border bg-background px-3 text-sm"
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Credit
                </label>
                <input
                  value={rowDraft.credit}
                  onChange={(e) =>
                    setRowDraft((p) => ({ ...p, credit: e.target.value }))
                  }
                  type="number"
                  placeholder="Credit"
                  className="h-10 rounded-lg border bg-background px-3 text-sm"
                />
              </div>
            </div>

            <Button
              type="button"
              onClick={handleAddRow}
              disabled={saving || !selectedBankAccountId || !statementSaved}
              className="h-10 w-full gap-2"
            >
              <Plus className="h-4 w-4" />
              Add Row
            </Button>
          </div>

          {selectedRows.length > 0 && (
            <div className="bank-table-scroll overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="border-b bg-muted/20 text-muted-foreground">
                  <tr className="sticky top-0 z-20 bg-background shadow-sm">
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2">Debit</th>
                    <th className="px-3 py-2">Credit</th>
                    <th className="px-3 py-2">Balance</th>
                    <th className="px-3 py-2">Suggestion</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {selectedRows.map((row, index) => (
                    <tr key={row.id ?? `${row.description}-${index}`}>
                      <td className="px-3 py-2">
                        {row.bankName
                          ? `${row.bankName} — ${row.accountLabel ?? "Account"}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2">{row.date || "—"}</td>
                      <td className="px-3 py-2">{row.description}</td>
                      <td className="px-3 py-2">{row.debit || "—"}</td>
                      <td className="px-3 py-2">{row.credit || "—"}</td>
                      <td className="px-3 py-2">{row.balance || "—"}</td>
                      <td className="px-3 py-2">
                        {row.classificationStatus === "SUGGESTED" ? (
                          <Badge
                            variant="outline"
                            className="border-amanah/25 bg-amanah/10 text-amanah"
                          >
                            {formatSuggestionPart(row.suggestedEntryType)} ·{" "}
                            {formatSuggestionPart(row.suggestedCategory)}
                          </Badge>
                        ) : row.classificationStatus === "POTENTIAL_INCOME" ? (
                          <Badge
                            variant="outline"
                            className="border-blue-200 bg-blue-50 text-blue-700"
                          >
                            Potential income
                          </Badge>
                        ) : row.classificationStatus === "POTENTIAL_ASSET" ? (
                          <Badge
                            variant="outline"
                            className="border-purple-200 bg-purple-50 text-purple-700"
                          >
                            Potential asset
                          </Badge>
                        ) : row.classificationStatus ===
                          "POTENTIAL_LIABILITY" ? (
                          <Badge
                            variant="outline"
                            className="border-orange-200 bg-orange-50 text-orange-700"
                          >
                            Potential liability
                          </Badge>
                        ) : row.classificationStatus ===
                          "POTENTIAL_TRANSFER" ? (
                          <Badge
                            variant="outline"
                            className="border-blue-200 bg-blue-50 text-blue-700"
                          >
                            Potential transfer
                          </Badge>
                        ) : row.classificationStatus ===
                          "POTENTIAL_CASH_MOVEMENT" ? (
                          <Badge
                            variant="outline"
                            className="border-amber-200 bg-amber-50 text-amber-700"
                          >
                            Potential cash movement
                          </Badge>
                        ) : row.classificationStatus === "APPROVED" ? (
                          <Badge
                            variant="outline"
                            className="border-blue-200 bg-blue-50 text-blue-700"
                          >
                            Approved
                          </Badge>
                        ) : row.classificationStatus === "TRANSFER" ? (
                          <Badge
                            variant="outline"
                            className="border-border bg-muted text-muted-foreground"
                          >
                            Internal transfer
                          </Badge>
                        ) : row.classificationStatus === "CASH_MOVEMENT" ? (
                          <Badge
                            variant="outline"
                            className="border-border bg-muted text-muted-foreground"
                          >
                            Cash movement
                          </Badge>
                        ) : row.classificationStatus === "REJECTED" ? (
                          <Badge
                            variant="outline"
                            className="border-border bg-muted text-muted-foreground"
                          >
                            Excluded
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            Unreviewed
                          </span>
                        )}
                      </td>
                      <td className="relative px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {row.id &&
                            row.classificationStatus === "SUGGESTED" && (
                              <>
                                <button
                                  type="button"
                                  title="Approve suggestion"
                                  onClick={() =>
                                    handleReview(row.id!, "APPROVE")
                                  }
                                  disabled={reviewingId === row.id}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-amanah transition-colors hover:bg-amanah hover:text-white"
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  title="Exclude from ledger"
                                  onClick={() =>
                                    handleReview(row.id!, "REJECT")
                                  }
                                  disabled={reviewingId === row.id}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-600 hover:text-white"
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          {row.id &&
                            [
                              "POTENTIAL_INCOME",
                              "POTENTIAL_ASSET",
                              "POTENTIAL_LIABILITY",
                              "POTENTIAL_TRANSFER",
                              "POTENTIAL_CASH_MOVEMENT",
                            ].includes(row.classificationStatus ?? "") && (
                              <>
                                {[
                                  "POTENTIAL_INCOME",
                                  "POTENTIAL_ASSET",
                                  "POTENTIAL_LIABILITY",
                                ].includes(row.classificationStatus ?? "") && (
                                  <button
                                    type="button"
                                    title={
                                      row.classificationStatus ===
                                      "POTENTIAL_INCOME"
                                        ? "Approve as income"
                                        : row.classificationStatus ===
                                            "POTENTIAL_ASSET"
                                          ? "Approve as asset"
                                          : "Approve as liability"
                                    }
                                    onClick={() =>
                                      handleReview(row.id!, "APPROVE")
                                    }
                                    disabled={reviewingId === row.id}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-amanah transition-colors hover:bg-amanah hover:text-white"
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  title="Exclude from ledger"
                                  onClick={() =>
                                    handleReview(row.id!, "REJECT")
                                  }
                                  disabled={reviewingId === row.id}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-600 hover:text-white"
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          {row.id &&
                            row.classificationStatus === "UNREVIEWED" && (
                              <button
                                type="button"
                                title="Exclude from ledger"
                                onClick={() => handleReview(row.id!, "REJECT")}
                                disabled={reviewingId === row.id}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-600 hover:text-white"
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </button>
                            )}
                          {row.id &&
                            row.classificationStatus !== "TRANSFER" && (
                              <button
                                type="button"
                                title="Mark as an internal transfer"
                                aria-label="Mark as an internal transfer"
                                onClick={() =>
                                  handleReview(row.id!, "TRANSFER")
                                }
                                disabled={reviewingId === row.id}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-blue-600 transition-colors hover:bg-blue-600 hover:text-white"
                              >
                                <ArrowLeftRight className="h-3.5 w-3.5" />
                              </button>
                            )}
                          {row.id &&
                            row.classificationStatus !== "CASH_MOVEMENT" && (
                              <button
                                type="button"
                                title="Mark as a cash movement"
                                aria-label="Mark as a cash movement"
                                onClick={() =>
                                  handleReview(row.id!, "CASH_MOVEMENT")
                                }
                                disabled={reviewingId === row.id}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-700 transition-colors hover:bg-emerald-700 hover:text-white"
                              >
                                <Banknote className="h-3.5 w-3.5" />
                              </button>
                            )}
                          {row.id &&
                            [
                              "UNREVIEWED",
                              "SUGGESTED",
                              "POTENTIAL_INCOME",
                              "POTENTIAL_ASSET",
                              "POTENTIAL_LIABILITY",
                              "POTENTIAL_TRANSFER",
                              "POTENTIAL_CASH_MOVEMENT",
                            ].includes(row.classificationStatus ?? "") && (
                              <button
                                type="button"
                                title="Choose a category manually"
                                onClick={(event) => {
                                  const rect =
                                    event.currentTarget.getBoundingClientRect();
                                  setManualReviewId(row.id!);
                                  setManualReviewPosition({
                                    top: rect.bottom + 4,
                                    left: Math.max(8, rect.right - 192),
                                  });
                                  setManualEntryType(
                                    row.credit ? "INCOME" : "EXPENSE",
                                  );
                                  setManualCategory("");
                                }}
                                disabled={reviewingId === row.id}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-purple-600 transition-colors hover:bg-purple-600 hover:text-white"
                                data-manual-review-trigger
                              >
                                <PenLine className="h-3.5 w-3.5" />
                              </button>
                            )}
                          {row.id &&
                            [
                              "APPROVED",
                              "REJECTED",
                              "TRANSFER",
                              "CASH_MOVEMENT",
                            ].includes(row.classificationStatus ?? "") && (
                              <button
                                type="button"
                                title="Undo decision"
                                onClick={() => handleUndo(row.id!)}
                                disabled={reviewingId === row.id}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
