"use server";

// File: app/actions/tax-calculation.ts
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateTaxEstimate } from "@/lib/tax/tax-calculation";
import type {
  TaxCalculationResult,
  TaxIncomeSource,
} from "@/lib/tax/tax-calculation";
import {
  TY2026_RULE_SET_VERSION,
  parseManualTaxpayerListStatus,
} from "@/lib/tax/tax-data-model";
import type { TaxpayerListStatus } from "@/lib/tax/tax-data-model";
import { assessPensionerAge } from "@/lib/tax/taxpayer-age";
import { isTaxActivitySource } from "@/lib/tax/filing-drafts";
import { getTy2026RateCardRule } from "@/lib/tax/rules/ty2026";
import {
  getTy2026SubcategoryDetailFields,
  parsePersistedSelectionUserDetails,
} from "@/lib/tax/rules/ty2026/subcategories";
import type { Ty2026SelectionUserDetails } from "@/lib/tax/rules/ty2026/subcategories";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import {
  extractMappedSalaryGross,
  extractMappedSalaryWithholding,
  normalizeLedgerCategory,
  resolveTaxWithheld,
} from "@/lib/tax/withholding-sources";
import { isGiftCategory } from "@/lib/tax/gift-income";
import { resolveSalaryTaxableIncome } from "@/lib/tax/salary-certificate-fields";
import { createNotification } from "@/app/actions/notifications";
import { sumMoney, toMoneyAmount } from "@/lib/money";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    // Date of birth drives the Section 149(IA) pension age condition. It is
    // populated from the taxpayer profile or from an approved CNIC upload.
    select: { id: true, dateOfBirth: true },
  });

  if (!user) throw new Error("User profile not found");

  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: {
      id: true,
      userId: true,
      taxYear: true,
      filerType: true,
      incomeSources: true,
      salaryPercentage: true,
      taxWithheld: true,
      incomeSelections: {
        where: { status: "SELECTED" },
        select: { source: true, subcategory: true, detailsJson: true },
      },
    },
  });

  if (!draft) throw new Error("Filing draft not found");

  return { ...draft, taxpayerDateOfBirth: user.dateOfBirth };
}

export async function calculateTaxAction(
  draftId: string,
  requestedFilerStatus: TaxpayerListStatus | string,
) {
  try {
    const filerStatus = parseManualTaxpayerListStatus(requestedFilerStatus);
    if (!filerStatus) {
      return {
        success: false,
        error: "Choose ATL, Late Filer or Non-ATL before calculating tax",
      };
    }

    const draft = await getOwnedDraft(draftId);
    const reconciliation = await validateAuthoritativeReconciliation({
      draftId: draft.id,
      userId: draft.userId,
    });
    if ("blockers" in reconciliation) {
      return {
        success: false,
        error: reconciliation.blockers.join(" · "),
      };
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: {
        entryType: true,
        category: true,
        amount: true,
        // Needed to name the suspect rows when salary withholding appears to
        // have been counted twice; see resolveTaxWithheld below.
        description: true,
      },
    });

    // These feed the tax engine, so they are summed in Decimal: `+` on a
    // Decimal column concatenates, and converting first reintroduces the
    // floating-point residue the migration exists to remove.
    // A gift received is a Wealth Statement inflow, not income: it is in the
    // ledger so Mizan balances, and it never reaches a tax figure.
    const totalIncome = sumMoney(
      entries
        .filter(
          (entry) =>
            entry.entryType === "INCOME" && !isGiftCategory(entry.category),
        )
        .map((entry) => entry.amount),
    );
    const totalExpenses = sumMoney(
      entries
        .filter((entry) => entry.entryType === "EXPENSE")
        .map((entry) => entry.amount),
    );
    const normalizeCategory = normalizeLedgerCategory;

    const incomeByCategory = (...categories: readonly string[]) =>
      sumMoney(
        entries
          .filter(
            (entry) =>
              entry.entryType === "INCOME" &&
              categories.includes(normalizeCategory(entry.category)),
          )
          .map((entry) => entry.amount),
      );

    const bankProfitIncome = incomeByCategory("BANK_PROFIT");
    const pensionIncome = incomeByCategory("PENSION");
    const rentalIncome = incomeByCategory("RENT", "RENTAL", "PROPERTY_RENT");
    // Each separately routed category must be recognised here. Anything not
    // listed falls into the salary remainder below, which would tax it under
    // Section 149 slabs instead of its own flat rate.
    const servicesIncome = incomeByCategory(
      "SERVICES",
      "SERVICE",
      "PROFESSIONAL_SERVICES",
      "CONSULTANCY",
    );
    const otherIncomeAmount = incomeByCategory(
      "OTHER_INCOME",
      "PRIZE",
      "PRIZE_MONEY",
      "WINNINGS",
      "COMMISSION",
      "BROKERAGE",
    );
    const capitalGainsIncome = incomeByCategory(
      "CAPITAL_GAINS",
      "CAPITAL_GAIN",
    );
    const dividendIncome = incomeByCategory("DIVIDEND", "DIVIDENDS");
    const nonResidentIncome = incomeByCategory(
      "NON_RESIDENT",
      "NON_RESIDENT_PAYMENT",
      "FOREIGN_INCOME_ASSETS",
      "FOREIGN_INCOME",
      "FOREIGN_ASSETS",
    );
    const businessIncome = incomeByCategory(
      "BUSINESS",
      "BUSINESS_INCOME",
      "SUPPLY",
      "SUPPLIES",
      "CONTRACT",
      "CONTRACTS",
      "ECOMMERCE",
      "E_COMMERCE",
      "EXPORT",
      "EXPORTS",
      "TRADING",
    );
    // Salary is whatever ordinary income remains once the separately routed
    // categories are removed, so an uncategorised income entry is still taxed
    // rather than silently dropped from the return.
    const salaryIncomeFromLedger = Math.max(
      0,
      totalIncome -
        bankProfitIncome -
        pensionIncome -
        rentalIncome -
        servicesIncome -
        otherIncomeAmount -
        capitalGainsIncome -
        businessIncome -
        dividendIncome -
        nonResidentIncome,
    );
    const bankSalaryIncome = incomeByCategory(
      "SALARY",
      "SALARIES",
      "SALARY_INCOME",
      "PAY_WAGES",
      "WAGES",
    );

    let incomeSources: string[] = [];
    try {
      const parsedIncomeSources = JSON.parse(draft.incomeSources);
      incomeSources = Array.isArray(parsedIncomeSources)
        ? parsedIncomeSources.map(String)
        : [];
    } catch {
      return {
        success: false,
        error: "Filing income sources are invalid; please review setup",
      };
    }

    // Phase 2 persists the exact PDF subcategory. Keep the pilot calculator
    // limited to the specific routes it actually implements; selecting a
    // different or additional subcategory must return NEEDS_RULES rather than
    // silently applying a bank-deposit/rental/salary formula to the wrong row.
    const selectedSubcategories = new Map<string, Set<string>>();
    const selectionDetails = new Map<string, Ty2026SelectionUserDetails>();
    for (const selection of draft.incomeSelections) {
      const sourceSelections =
        selectedSubcategories.get(selection.source) ?? new Set<string>();
      sourceSelections.add(selection.subcategory);
      selectedSubcategories.set(selection.source, sourceSelections);
      const details = parsePersistedSelectionUserDetails(selection.detailsJson);
      if (details) {
        selectionDetails.set(
          `${selection.source}\u0000${selection.subcategory}`,
          details,
        );
      }
    }
    const hasOnlySubcategories = (
      source: string,
      allowed: readonly string[],
    ) => {
      const selected = selectedSubcategories.get(source) ?? new Set<string>();
      return (
        selected.size > 0 &&
        Array.from(selected).every((subcategory) =>
          allowed.includes(subcategory),
        )
      );
    };

    // Each route is recognised on its own merits. A filing may select several
    // of them; the calculator prices every selected route and reports which
    // combinations still need a confirmed assessment rule.
    const isSalariedRoute =
      incomeSources.includes("salary") &&
      hasOnlySubcategories("salary", ["salary", "salary-surcharge"]);
    // Profit on debt is priced through the flat-route list below, which
    // resolves the selected Section 151 row. This flag only tells the
    // calculator which single-route legacy path to use when no per-route
    // income list is supplied.
    const isBankProfitRoute = incomeSources.includes("bank_profit");
    // Section 149(IA) catalogues the exempt band and the above-10m band for a
    // pensioner below 70. Both are routed; the calculator itself reports
    // NEEDS_RULES when an above-10m case has no confirmed age.
    const isPensionRoute =
      incomeSources.includes("pension") &&
      hasOnlySubcategories("pension", [
        "pension-up-to-10m",
        "pension-above-10m-below-age-70",
        "former-employer-or-associate",
      ]);
    // The former-employer row references Section 149, so the whole pension
    // is priced on the salary slabs when it is selected.
    const pensionTaxAsSalary = (
      selectedSubcategories.get("pension") ?? new Set<string>()
    ).has("former-employer-or-associate");

    // Age is derived from the taxpayer's recorded date of birth rather than
    // from the selected subcategory, so the age condition is evidence-based.
    // An approved CNIC upload writes this date onto the profile.
    const pensionerAge = assessPensionerAge({
      taxYear: draft.taxYear,
      dateOfBirth: draft.taxpayerDateOfBirth,
    });

    // Section 155 charges an individual/AOP by slab and a company at a flat
    // rate, so the selected subcategory decides which formula is used.
    const isRentalRoute =
      incomeSources.includes("property_rent") &&
      (hasOnlySubcategories("property_rent", ["individual-aop"]) ||
        hasOnlySubcategories("property_rent", ["company"]));
    const rentalRecipientKind = hasOnlySubcategories("property_rent", [
      "company",
    ])
      ? ("COMPANY" as const)
      : ("INDIVIDUAL_OR_AOP" as const);

    /**
     * Flat routes: the rate depends on which catalog row the filing selected,
     * so each selected subcategory becomes its own breakdown line.
     *
     * The ledger records one amount per category, not one per subcategory. So
     * where a filing selects several categories under one source there is no
     * evidence for how the income splits between them, and apportioning it
     * would be an invention. Those cases stop with NEEDS_RULES; the operator
     * can split the ledger entries and recalculate.
     */
    const flatRouteInputs = [
      {
        source: "services",
        route: "services" as const,
        income: servicesIncome,
      },
      {
        source: "other_income",
        route: "other_income" as const,
        income: otherIncomeAmount,
      },
      {
        source: "capital_gains",
        route: "capital_gains" as const,
        income: capitalGainsIncome,
      },
      {
        source: "business",
        route: "business" as const,
        income: businessIncome,
      },
      {
        source: "dividend",
        route: "dividend" as const,
        income: dividendIncome,
      },
      {
        source: "foreign_income_assets",
        route: "foreign_income_assets" as const,
        income: nonResidentIncome,
      },
      // Section 151 has six catalogued rows from 10% to 25%, so profit on debt
      // is resolved from the selected subcategory like every other multi-rate
      // route rather than being pinned to the bank-deposit row.
      {
        source: "bank_profit",
        route: "bank_profit" as const,
        income: bankProfitIncome,
      },
    ];

    const flatRouteSources: TaxIncomeSource[] = [];
    const flatRoutesNeedingSplit: string[] = [];
    const routedFlatSourceNames = new Set<string>();

    for (const entry of flatRouteInputs) {
      if (!incomeSources.includes(entry.source)) continue;

      const selected = Array.from(
        selectedSubcategories.get(entry.source) ?? new Set<string>(),
      );
      if (selected.length === 0) continue;

      if (selected.length > 1) {
        flatRoutesNeedingSplit.push(entry.source);
        continue;
      }

      const details = selectionDetails.get(
        `${entry.source}\u0000${selected[0]}`,
      );
      flatRouteSources.push({
        route: entry.route,
        income: entry.income,
        subcategory: selected[0],
        // The composite mutual-fund row prices its declared debt/equity
        // split; every other flat row prices from the ledger amount alone.
        ...(entry.source === "dividend" &&
        selected[0] === "mutual-fund-proportional"
          ? {
              attributes: {
                debtPortion: details?.debtPortion,
                equityPortion: details?.equityPortion,
              },
            }
          : {}),
      });
      routedFlatSourceNames.add(entry.source);
    }

    /**
     * Activity routes: imports and advance tax. Unlike income routes, each
     * selection carries its own declared figures, so several categories
     * under one source never need a ledger split — every card prices its
     * own transaction. Required figures are enforced here against the same
     * field contract the wizard renders.
     */
    const activitySources: TaxIncomeSource[] = [];
    const activityDetailProblems: string[] = [];
    const routedActivitySourceNames = new Set<string>();

    for (const source of incomeSources.filter(isTaxActivitySource)) {
      const selected = Array.from(
        selectedSubcategories.get(source) ?? new Set<string>(),
      );
      if (selected.length === 0) continue;
      routedActivitySourceNames.add(source);

      for (const subcategory of selected) {
        const details =
          selectionDetails.get(`${source}\u0000${subcategory}`) ?? {};
        const missing = getTy2026SubcategoryDetailFields(source, subcategory)
          .filter((field) => {
            if (!field.required) return false;
            const value = details[field.key];
            // A yes/no answer counts once given, either way; numbers must
            // additionally clear the field floor.
            if (field.checkbox === true) return value === undefined;
            return (
              value === undefined ||
              typeof value !== "number" ||
              value < field.min
            );
          })
          .map((field) =>
            details[field.key] === undefined
              ? field.label
              : `${field.label} (minimum ${field.min})`,
          );
        if (missing.length > 0) {
          activityDetailProblems.push(
            `${source}/${subcategory}: enter ${missing.join(", ")}`,
          );
          continue;
        }
        activitySources.push({
          route: source,
          income: details.amount ?? 0,
          subcategory,
          attributes: {
            engineCapacityCc: details.engineCapacityCc,
            seatCount: details.seatCount,
            ladenWeightKg: details.ladenWeightKg,
            unitQuantity: details.unitQuantity,
            cfValueUsd: details.cfValueUsd,
            isSmartphone: details.isSmartphone,
            vehicleAgeYears: details.vehicleAgeYears,
          },
        });
      }
    }

    // Section 149 withholding, read from the mapped salary certificate. The
    // stored column is not consulted here: it is this action's own output, so
    // reading it back would make the result depend on how many times the user
    // has pressed Calculate.
    let certificateTaxWithheld = 0;
    let certificateGrossSalary: number | null = null;
    if (isSalariedRoute) {
      const salaryCertificate = await prisma.document.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "salary_certificate",
          extractionStatus: "MAPPED",
        },
        select: { extractedData: true },
      });
      certificateGrossSalary = extractMappedSalaryGross(
        salaryCertificate?.extractedData ?? null,
      );
      certificateTaxWithheld =
        extractMappedSalaryWithholding(
          salaryCertificate?.extractedData ?? null,
        ) ?? 0;
    }

    const salaryIncomeForTax = resolveSalaryTaxableIncome({
      ledgerSalaryRemainder: salaryIncomeFromLedger,
      bankSalaryIncome,
      certificateGrossSalary,
    });

    // Section 149 (certificate) and Section 151 (ledger) are added, and the
    // combination is flagged rather than silently adjusted when the same
    // deduction may appear on both sides. See lib/tax/withholding-sources.ts
    // for why the stored column is not an input to this.
    const withholding = resolveTaxWithheld({
      certificateTaxWithheld,
      entries,
      storedTaxWithheld: toMoneyAmount(draft.taxWithheld),
    });
    const taxWithheld = withholding.taxWithheld;

    // Build the per-route income list the calculator prices. The order here is
    // irrelevant; the calculator sorts the breakdown into a stable order.
    const routedIncomeSources: TaxIncomeSource[] = [];
    if (isSalariedRoute) {
      routedIncomeSources.push({
        route: "salary",
        income: salaryIncomeForTax,
      });
    }
    if (isPensionRoute) {
      routedIncomeSources.push({ route: "pension", income: pensionIncome });
    }
    if (isRentalRoute) {
      routedIncomeSources.push({
        route: "property_rent",
        income: rentalIncome,
      });
    }
    routedIncomeSources.push(...flatRouteSources);
    routedIncomeSources.push(...activitySources);

    // A selected source with no implemented route must stop the estimate. If
    // it were ignored, its income would be absorbed into the salary remainder
    // and taxed under the wrong section.
    const routedSourceNames = new Set<string>();
    if (isSalariedRoute) routedSourceNames.add("salary");
    if (isPensionRoute) routedSourceNames.add("pension");
    if (isRentalRoute) routedSourceNames.add("property_rent");
    for (const source of routedFlatSourceNames) routedSourceNames.add(source);
    for (const source of routedActivitySourceNames) {
      routedSourceNames.add(source);
    }

    const unroutedSources = incomeSources.filter(
      (source) => !routedSourceNames.has(source),
    );

    const estimate = calculateTaxEstimate({
      taxYear: draft.taxYear,
      filerStatus,
      totalIncome,
      totalExpenses,
      bankProfitIncome,
      incomeSources: routedIncomeSources,
      // Use withholding extracted from the filing documents instead of
      // resetting it to zero during every recalculation.
      taxWithheld,
      isSalariedRoute,
      isPensionRoute,
      isRentalRoute,
      isBankProfitRoute,
      pensionerAgeBelow70: pensionerAge.isBelow70,
      pensionerAgeReason: pensionerAge.reason,
      // isBelow70 is false for 70+ and unknown alike (turns-70 counts as
      // below-70 under the confirmed first-day rule), so the exemption
      // needs its own confirmed signal: 70 for the whole year.
      pensionerAge70OrAbove: pensionerAge.bracket === "SEVENTY_OR_ABOVE",
      pensionTaxAsSalary,
      rentalRecipientKind,
    });

    const blockedNote =
      activityDetailProblems.length > 0
        ? `This filing is missing figures for ${activityDetailProblems.join(" · ")}. Open the category step, enter the missing figures, save, and recalculate.`
        : flatRoutesNeedingSplit.length > 0
          ? `This filing selects more than one category under ${flatRoutesNeedingSplit.join(", ")}, and each category is charged at its own rate. The ledger records a single amount per source, so there is no evidence for how the income divides between those categories. Record the income as separate ledger entries per category, or select a single category, and recalculate.`
          : unroutedSources.length > 0
            ? `This filing selects ${unroutedSources.join(", ")}, for which no TY2026 route is implemented yet. Confirmed rules are required before those sources can be included in an estimate.`
            : null;

    const result: TaxCalculationResult = blockedNote
      ? {
          ...estimate,
          status: "NEEDS_RULES",
          taxableIncome: null,
          baseTax: null,
          surcharge: null,
          taxDue: null,
          taxPayable: null,
          refundDue: null,
          appliedRuleIds: [],
          breakdown: [],
          finalTaxDue: 0,
          assessableTaxDue: 0,
          collectionBreakdown: [],
          collectionTaxDue: 0,
          note: blockedNote,
        }
      : estimate;

    const calculatedAt = new Date();
    const calculationRevision = randomUUID();

    // Persist the per-route breakdown as an audit trail. Each recalculation
    // writes a new revision, so an approved packet can always be re-read
    // against the exact lines that produced its totals.
    // Both income lines and collection lines persist to the audit table; the
    // filing summary splits them back apart for display.
    const pricedLines = [...result.breakdown, ...result.collectionBreakdown];
    const calculationLines = pricedLines.map((line) => {
      const primaryRule = line.appliedRuleIds[0]
        ? getTy2026RateCardRule(line.appliedRuleIds[0])
        : null;

      return {
        filingDraftId: draft.id,
        userId: draft.userId,
        calculationRevision: calculationRevision,
        ruleSetVersion: TY2026_RULE_SET_VERSION,
        ruleId: line.appliedRuleIds[0] ?? "UNKNOWN",
        section: primaryRule?.section ?? "",
        source: line.route,
        subcategory: primaryRule?.subcategory ?? "",
        filerStatusUsed: filerStatus,
        taxBase: line.income,
        baseTax: line.baseTax,
        surcharge: line.surcharge,
        calculatedTax: line.taxDue,
        detailsJson: JSON.stringify({
          rateShape: line.rateShape,
          isFinalTax: line.isFinalTax,
          appliedRuleIds: line.appliedRuleIds,
          note: line.note,
          combinedRoutes: line.combinedRoutes ?? [],
        }),
      };
    });

    await prisma.$transaction(async (tx) => {
      await tx.filingDraft.update({
        where: { id: draft.id },
        data: {
          status: "IN_PROGRESS",
          taxableIncome: result.taxableIncome,
          taxWithheld: result.taxWithheld,
          taxPayable: result.taxPayable,
          refundDue: result.refundDue,
          taxCalculationStatus: result.status,
          taxpayerListStatus: filerStatus,
          taxpayerListStatusSource: "MANUAL",
          taxpayerListStatusCheckedAt: calculatedAt,
          taxRuleSetVersion: TY2026_RULE_SET_VERSION,
          taxCalculationRevision: calculationRevision,
          packetApprovalConfirmed: false,
          packetApprovalAt: null,
          packetApprovalByUserId: null,
        },
      });

      // Replace the previous revision's lines. Keeping only the current
      // revision avoids a draft accumulating stale breakdowns that no longer
      // match the totals stored on the draft itself.
      await tx.filingTaxCalculationLine.deleteMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
      });
      if (calculationLines.length > 0) {
        await tx.filingTaxCalculationLine.createMany({
          data: calculationLines,
        });
      }

      // A calculation under a selected filer status is a new authoritative
      // result. Any packet/PDF/approval generated for an older result must not
      // survive an ATL/Late Filer/Non-ATL switch or recalculation.
      await tx.filingPacket.updateMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          status: { not: "SUPERSEDED" },
        },
        data: {
          status: "SUPERSEDED",
          approvalStatus: "SUPERSEDED",
        },
      });

      await tx.fbrConnection.updateMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        data: {
          status: "NOT_STARTED",
          agentId: null,
          message: null,
          errorMessage: null,
          lastHeartbeat: null,
          startedAt: null,
          completedAt: null,
        },
      });
    });

    await createNotification({
      userId: draft.userId,
      type: "FILING_STATUS",
      title: `${filerStatus} tax estimate updated — Tax Year ${draft.taxYear}`,
      message:
        result.status === "ESTIMATE"
          ? `${filerStatus} estimate · Tax payable: PKR ${(result.taxPayable ?? 0).toLocaleString()} · Refund due: PKR ${(result.refundDue ?? 0).toLocaleString()}.`
          : "Tax calculation needs a route-specific rule set before a final estimate is available.",
      link: `/tax/new?draftId=${draft.id}`,
    });

    return {
      success: true,
      result,
      filerStatus,
      calculationRevision,
      // Non-blocking: the estimate is valid, but the same deduction may have
      // been counted from both the certificate and the ledger. Surfaced so the
      // user resolves it before filing rather than after an FBR notice.
      withholdingWarning: withholding.duplicateWarning,
    };
  } catch (error) {
    console.error("Error calculating tax:", error);
    return { success: false, error: "Failed to calculate tax" };
  }
}
