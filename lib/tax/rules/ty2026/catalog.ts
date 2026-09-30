import type {
  RateCardRule,
  RateCardValue,
} from "@/lib/tax/rules/rate-card-types";

const defaultReference =
  "FBR Withholding Income Tax Rate Card updated through 30 June 2025 under Finance Act 2025";

const zero = (): RateCardValue => ({ kind: "ZERO" });
const notApplicable = (): RateCardValue => ({ kind: "NOT_APPLICABLE" });
const percent = (value: number, basis: string): RateCardValue => ({
  kind: "PERCENT",
  percent: value,
  basis,
});
const marginal = (
  baseTax: number,
  value: number,
  excessOver: number,
  basis: string,
): RateCardValue => ({
  kind: "MARGINAL",
  baseTax,
  percent: value,
  excessOver,
  basis,
});
const fixed = (amount: number, per?: string): RateCardValue => ({
  kind: "FIXED",
  amount,
  ...(per ? { per } : {}),
});
const perUnit = (amount: number, unit: string): RateCardValue => ({
  kind: "PER_UNIT",
  amount,
  unit,
});
const range = (
  minimum: number,
  maximum: number,
  basis: string,
): RateCardValue => ({ kind: "RANGE", minimum, maximum, basis });
const sectionReference = (section: string): RateCardValue => ({
  kind: "REFERENCE",
  section,
});

function rule(
  input: Omit<RateCardRule, "taxYear" | "reference" | "implementationStatus"> &
    Partial<
      Pick<RateCardRule, "reference" | "implementationStatus">
    >,
): RateCardRule {
  return {
    taxYear: 2026,
    reference: defaultReference,
    implementationStatus: "CATALOGUED",
    ...input,
  };
}

function atlNonAtlRule(input: {
  id: string;
  page: number;
  section: string;
  family: RateCardRule["family"];
  source: string;
  subcategory: string;
  label: string;
  atl: RateCardValue;
  nonAtl: RateCardValue;
  condition?: RateCardRule["condition"];
  reference?: string;
  implementationStatus?: RateCardRule["implementationStatus"];
  notes?: ReadonlyArray<string>;
}): RateCardRule {
  return rule({
    ...input,
    rates: { ATL: input.atl, NON_ATL: input.nonAtl },
  });
}

const rules: RateCardRule[] = [];

// Section 148 — Imports (PDF page 1)
[
  ["PART-I", "Goods falling in Part-I of Twelfth Schedule", 1, 2],
  ["PART-II", "Goods falling in Part-II of Twelfth Schedule", 2, 4],
  [
    "PART-II-COMMERCIAL",
    "Goods falling in Part-II of Twelfth Schedule — commercial importer",
    3.5,
    7,
  ],
  ["PART-III", "Goods falling in Part-III of Twelfth Schedule", 5.5, 11],
  [
    "PART-III-COMMERCIAL",
    "Goods falling in Part-III of Twelfth Schedule — commercial importer",
    6,
    12,
  ],
  [
    "SRO-1125-MANUFACTURER",
    "Proviso 1(a) manufacturer falling in SRO 1125(I)/2011",
    1,
    2,
  ],
  ["PHARMA", "Proviso 1(b) pharmaceutical products", 4, 8],
  ["EV-CKD", "Proviso 1(c) CKD kits for electric vehicles", 1, 2],
].forEach(([key, label, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-148-${key}`,
      page: 1,
      section: "148",
      family: "WITHHOLDING",
      source: "imports",
      subcategory: String(key).toLowerCase(),
      label: String(label),
      atl: percent(Number(atl), "IMPORT_VALUE"),
      nonAtl: percent(Number(nonAtl), "IMPORT_VALUE"),
    }),
  );
});

rules.push(
  atlNonAtlRule({
    id: "TY2026-148-MOBILE-PCT-8517-1219",
    page: 1,
    section: "148",
    family: "WITHHOLDING",
    source: "imports",
    subcategory: "mobile-pct-8517-1219",
    label: "Mobile phones under PCT 8517.1219",
    atl: range(70, 11_500, "REFERENCE_BANDS"),
    nonAtl: range(140, 23_000, "REFERENCE_BANDS"),
    notes: [
      "Priced from the C&F value band table in Part-II of the First Schedule (Ordinance); the card range is that table's minimum and maximum.",
    ],
  }),
  atlNonAtlRule({
    id: "TY2026-148-MOBILE-PCT-8517-1211",
    page: 1,
    section: "148",
    family: "WITHHOLDING",
    source: "imports",
    subcategory: "mobile-pct-8517-1211",
    label: "Mobile phones under PCT 8517.1211",
    atl: range(0, 5_200, "REFERENCE_BANDS"),
    nonAtl: range(0, 10_400, "REFERENCE_BANDS"),
    notes: [
      "Priced from the C&F value band table in Part-II of the First Schedule (Ordinance); the card range is that table's minimum and maximum.",
    ],
  }),
);

// Section 149 — Salary (PDF pages 1–2)
[
  ["UP-TO-600K", 0, 600_000, zero()],
  ["600K-1M2", 600_000, 1_200_000, marginal(0, 1, 600_000, "TAXABLE_INCOME")],
  ["1M2-2M2", 1_200_000, 2_200_000, marginal(6_000, 11, 1_200_000, "TAXABLE_INCOME")],
  ["2M2-3M2", 2_200_000, 3_200_000, marginal(116_000, 23, 2_200_000, "TAXABLE_INCOME")],
  ["3M2-4M1", 3_200_000, 4_100_000, marginal(346_000, 30, 3_200_000, "TAXABLE_INCOME")],
  ["ABOVE-4M1", 4_100_000, null, marginal(616_000, 35, 4_100_000, "TAXABLE_INCOME")],
].forEach(([key, lower, upper, value], index) => {
  rules.push(
    rule({
      id: `TY2026-149-SALARY-${key}`,
      page: index < 3 ? 1 : 2,
      section: "149",
      family: "INCOME",
      source: "salary",
      subcategory: "salary",
      label: `Salary taxable-income band ${String(key).toLowerCase()}`,
      condition: {
        amount: {
          field: "taxableIncome",
          ...(Number(lower) === 0
            ? { minInclusive: 0 }
            : { minExclusive: Number(lower) }),
          ...(upper === null ? {} : { maxInclusive: Number(upper) }),
        },
      },
      rates: { DEFAULT: value as RateCardValue },
    }),
  );
});

rules.push(
  rule({
    id: "TY2026-149-SALARY-SURCHARGE-ABOVE-10M",
    page: 2,
    section: "149",
    family: "INCOME",
    source: "salary",
    subcategory: "salary-surcharge",
    label: "Salary surcharge where taxable income exceeds PKR 10 million",
    condition: {
      amount: { field: "taxableIncome", minExclusive: 10_000_000 },
    },
    rates: {},
    surcharge: { percent: 9, basis: "CALCULATED_TAX" },
    notes: [
      "Client-confirmed product rule: the surcharge percentage is applied to calculated tax, not directly to taxable income.",
    ],
  }),
);

// Section 149(IA) — Pension (PDF page 2)
rules.push(
  rule({
    id: "TY2026-149IA-PENSION-UP-TO-10M",
    page: 2,
    section: "149(IA)",
    family: "INCOME",
    source: "pension",
    subcategory: "pension-up-to-10m",
    label: "Pension not exceeding PKR 10 million",
    condition: {
      amount: { field: "annualPension", minInclusive: 0, maxInclusive: 10_000_000 },
    },
    rates: { DEFAULT: zero() },
  }),
  rule({
    id: "TY2026-149IA-PENSION-ABOVE-10M-BELOW-AGE-70",
    page: 2,
    section: "149(IA)",
    family: "INCOME",
    source: "pension",
    subcategory: "pension-above-10m-below-age-70",
    label: "Pension above PKR 10 million where age is below 70",
    condition: {
      amount: { field: "annualPension", minExclusive: 10_000_000 },
      attributes: { ageBelow: 70 },
    },
    rates: {
      DEFAULT: marginal(0, 5, 10_000_000, "ANNUAL_PENSION"),
    },
    surcharge: { percent: 10, basis: "CALCULATED_TAX" },
    notes: [
      "Client-confirmed product rule: the surcharge percentage is applied to calculated tax.",
      "The rate card does not state the age-70-or-above treatment.",
    ],
  }),
  rule({
    id: "TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE",
    page: 2,
    section: "149(IA)",
    family: "INCOME",
    source: "pension",
    subcategory: "former-employer-or-associate",
    label: "Pension recipient continuing to work for former employer or its associate",
    condition: {
      attributes: { worksForFormerEmployerOrAssociate: true },
    },
    rates: { DEFAULT: sectionReference("149") },
    notes: ["Apply Section 149 subject to the applicable salary clause."],
  }),
);

// Section 150 — Dividend (PDF pages 2–3)
rules.push(
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-IPP",
    page: 2,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "ipp",
    label: "Dividend paid by an Independent Power Producer",
    atl: percent(7.5, "GROSS_DIVIDEND"),
    nonAtl: percent(15, "GROSS_DIVIDEND"),
  }),
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-REIT-AND-OTHER",
    page: 2,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "reit-and-other",
    label: "REIT and other dividend cases covered by the rate-card row",
    atl: percent(15, "GROSS_DIVIDEND"),
    nonAtl: percent(30, "GROSS_DIVIDEND"),
  }),
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-MUTUAL-FUND-PROPORTIONAL",
    page: 3,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "mutual-fund-proportional",
    label: "Mutual-fund dividend apportioned by debt and equity income",
    atl: {
      kind: "COMPOSITE",
      formula: "25% of debt-derived portion plus 15% of equity-derived portion",
      components: [
        { label: "Debt-derived portion", percent: 25, basis: "DEBT_PORTION" },
        { label: "Equity-derived portion", percent: 15, basis: "EQUITY_PORTION" },
      ],
    },
    nonAtl: {
      kind: "COMPOSITE",
      formula: "50% of debt-derived portion plus 30% of equity-derived portion",
      components: [
        { label: "Debt-derived portion", percent: 50, basis: "DEBT_PORTION" },
        { label: "Equity-derived portion", percent: 30, basis: "EQUITY_PORTION" },
      ],
    },
  }),
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-MUTUAL-FUND-DEBT-50-PERCENT-OR-MORE",
    page: 3,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "mutual-fund-debt-50-or-more",
    label: "Mutual fund deriving 50% or more income from profit on debt",
    atl: percent(25, "GROSS_DIVIDEND"),
    nonAtl: percent(50, "GROSS_DIVIDEND"),
  }),
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-REIT-RECEIVES-FROM-SPV",
    page: 3,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "reit-receives-from-spv",
    label: "Dividend received by a REIT scheme from an SPV",
    atl: zero(),
    nonAtl: zero(),
  }),
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-OTHER-RECIPIENT-FROM-SPV",
    page: 3,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "other-recipient-from-spv",
    label: "Dividend received by another recipient from a REIT SPV",
    atl: percent(35, "GROSS_DIVIDEND"),
    nonAtl: percent(70, "GROSS_DIVIDEND"),
  }),
  atlNonAtlRule({
    id: "TY2026-150-DIVIDEND-EXEMPT-LOSS-OR-CREDIT-COMPANY",
    page: 3,
    section: "150",
    family: "WITHHOLDING",
    source: "dividend",
    subcategory: "exempt-loss-or-credit-company",
    label: "Dividend from company with no tax payable due to exemption, losses or tax credits",
    atl: percent(25, "GROSS_DIVIDEND"),
    nonAtl: percent(50, "GROSS_DIVIDEND"),
  }),
);

// Section 151 — Profit on debt (PDF page 3)
[
  ["BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "Bank or financial-institution account/deposit", 20, 40],
  ["GOVERNMENT-SECURITIES-NON-INDIVIDUAL", "Government securities paid to a person other than an individual", 20, 40],
  ["OTHER-PROFIT-ON-DEBT", "Other profit-on-debt cases", 15, 30],
  ["SUKUK-COMPANY", "Sukuk holder is a company", 25, 50],
  ["SUKUK-INDIVIDUAL-AOP-ABOVE-1M", "Sukuk holder is individual/AOP with return above PKR 1 million", 12.5, 25],
  ["SUKUK-INDIVIDUAL-AOP-BELOW-1M", "Sukuk holder is individual/AOP with return below PKR 1 million", 10, 20],
].forEach(([key, label, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-151-${key}`,
      page: 3,
      section: "151",
      family: "WITHHOLDING",
      source: "bank_profit",
      subcategory: String(key).toLowerCase(),
      label: String(label),
      atl: percent(Number(atl), "GROSS_PROFIT_ON_DEBT"),
      nonAtl: percent(Number(nonAtl), "GROSS_PROFIT_ON_DEBT"),
      ...(String(key).includes("ABOVE-1M")
        ? {
            condition: {
              amount: { field: "returnOnInvestment", minExclusive: 1_000_000 },
            },
          }
        : {}),
      ...(String(key).includes("BELOW-1M")
        ? {
            condition: {
              amount: { field: "returnOnInvestment", maxExclusive: 1_000_000 },
            },
            implementationStatus: "NEEDS_EXTERNAL_DETAIL" as const,
            notes: ["The rate card does not state the exact-PKR-1-million boundary."],
          }
        : {}),
    }),
  );
});

// Section 151A — Gain on certain debt securities (PDF page 4)
rules.push(
  atlNonAtlRule({
    id: "TY2026-151A-DEBT-SECURITY-GAIN",
    page: 4,
    section: "151A",
    family: "WITHHOLDING",
    source: "capital_gains",
    subcategory: "certain-debt-securities",
    label: "Gain arising on disposal of certain debt securities",
    atl: percent(15, "GROSS_CAPITAL_GAIN"),
    nonAtl: percent(30, "GROSS_CAPITAL_GAIN"),
  }),
);

// Section 152 — Payments to non-residents (PDF pages 4–5)
[
  ["1", "Sub-section (1)", 15],
  ["1A", "Sub-section (1A)", 7],
  ["1AA", "Sub-section (1AA)", 5],
  ["1AAA", "Sub-section (1AAA)", 10],
  ["1BA", "Sub-section (1BA)", 20],
  ["1C", "Sub-section (1C)", 10],
  ["1D-HOLDING-OVER-12-MONTHS", "Sub-section (1D), holding period greater than 12 months", 10],
  ["1D-HOLDING-UNDER-12-MONTHS", "Sub-section (1D), holding period less than 12 months", 10],
  ["1DA", "Sub-section (1DA)", 10],
  ["1DB-SUKUK-COMPANY", "Sub-section (1DB), Sukuk holder is a company", 25],
  ["1DB-SUKUK-INDIVIDUAL-AOP-ABOVE-1M", "Sub-section (1DB), individual/AOP return above PKR 1 million", 12.5],
  ["1DB-SUKUK-INDIVIDUAL-AOP-BELOW-1M", "Sub-section (1DB), individual/AOP return below PKR 1 million", 10],
].forEach(([key, label, value], index) => {
  rules.push(
    rule({
      id: `TY2026-152-${key}`,
      page: index < 11 ? 4 : 5,
      section: "152",
      family: "WITHHOLDING",
      source: "foreign_income_assets",
      subcategory: String(key).toLowerCase(),
      label: String(label),
      rates: { DEFAULT: percent(Number(value), "GROSS_PAYABLE") },
      ...(String(key).includes("ABOVE-1M")
        ? {
            condition: {
              amount: { field: "returnOnInvestment", minExclusive: 1_000_000 },
            },
          }
        : {}),
      ...(String(key).includes("BELOW-1M")
        ? {
            condition: {
              amount: { field: "returnOnInvestment", maxExclusive: 1_000_000 },
            },
            implementationStatus: "NEEDS_EXTERNAL_DETAIL" as const,
            notes: ["The rate card does not state the exact-PKR-1-million boundary."],
          }
        : {}),
    }),
  );
});

[
  ["2A-A-COMPANY", "Section 152(2A)(a), company", 5, 10, "GROSS_SUPPLY_PAYMENT"],
  ["2A-A-OTHER", "Section 152(2A)(a), other than company", 5.5, 11, "GROSS_SUPPLY_PAYMENT"],
  ["2A-B-IT-ITES", "Section 152(2A)(b), IT and IT-enabled services", 4, 8, "GROSS_SERVICE_PAYMENT"],
  ["2A-B-CERTAIN-OTHER-SERVICES", "Section 152(2A)(b), services other than IT/IT-enabled services", 8, 16, "GROSS_SERVICE_PAYMENT"],
  ["2A-B-OTHER-SERVICES", "Section 152(2A)(b), other services under the stated residual sub-paragraph", 15, 30, "GROSS_SERVICE_PAYMENT"],
  ["2A-C-SPORTSPERSON", "Section 152(2A)(c), contract — sportsperson", 15, 30, "GROSS_CONTRACT_PAYMENT"],
  ["2A-C-OTHER", "Section 152(2A)(c), contract — other than sportsperson", 8, 16, "GROSS_CONTRACT_PAYMENT"],
].forEach(([key, label, atl, nonAtl, basis]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-152-${key}`,
      page: 5,
      section: "152",
      family: "WITHHOLDING",
      source: "foreign_income_assets",
      subcategory: String(key).toLowerCase(),
      label: String(label),
      atl: percent(Number(atl), String(basis)),
      nonAtl: percent(Number(nonAtl), String(basis)),
    }),
  );
});

// Section 153 — Goods, services, contracts and e-commerce (PDF pages 5–7)
[
  ["1A-SUPPLY-RICE-COTTON-SEED-EDIBLE-OIL", "Supply of rice, cotton seed or edible oils", 1.5, 3, 5, "GROSS_SUPPLY_PAYMENT"],
  ["1A-SUPPLY-COMPANY-TOLL-MANUFACTURING", "Supply by company — toll manufacturing", 9, 18, 5, "GROSS_SUPPLY_PAYMENT"],
  ["1A-SUPPLY-COMPANY-OTHER", "Supply by company — other than toll manufacturing", 5, 10, 6, "GROSS_SUPPLY_PAYMENT"],
  ["1A-SUPPLY-NON-COMPANY-TOLL-MANUFACTURING", "Supply by non-company — toll manufacturing", 11, 22, 6, "GROSS_SUPPLY_PAYMENT"],
  ["1A-SUPPLY-NON-COMPANY-OTHER", "Supply by non-company — other than toll manufacturing", 5.5, 11, 6, "GROSS_SUPPLY_PAYMENT"],
  ["1B-SERVICE-CERTAIN", "Certain services", 6, 12, 6, "GROSS_SERVICE_PAYMENT"],
  ["1B-SERVICE-IT-ITES", "IT and IT-enabled services", 4, 8, 6, "GROSS_SERVICE_PAYMENT"],
  ["1B-SERVICE-OTHER", "Other services under the stated residual sub-paragraph", 15, 30, 6, "GROSS_SERVICE_PAYMENT"],
  ["1B-SERVICE-ADVERTISING-MEDIA", "Advertising services paid to electronic or print media", 1.5, 3, 6, "GROSS_SERVICE_PAYMENT"],
  ["1C-CONTRACT-SPORTSPERSON", "Contract payment to sportsperson", 15, 30, 6, "GROSS_CONTRACT_PAYMENT"],
  ["1C-CONTRACT-COMPANY", "Contract payment to company", 7.5, 15, 6, "GROSS_CONTRACT_PAYMENT"],
  ["1C-CONTRACT-OTHER", "Contract payment — any other case", 8, 16, 6, "GROSS_CONTRACT_PAYMENT"],
  ["2-SERVICES-TO-EXPORTER", "Certain services provided to exporters or export houses", 1, 2, 6, "GROSS_SERVICE_PAYMENT"],
  ["2A-ECOMMERCE-DIGITAL", "Digitally ordered goods/services paid through digital or banking channels", 1, 2, 6, "GROSS_PAYABLE"],
  ["2A-ECOMMERCE-COD", "Digitally ordered goods/services paid cash on delivery", 2, 4, 7, "GROSS_PAYABLE"],
].forEach(([key, label, atl, nonAtl, page, basis]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-153-${key}`,
      page: Number(page),
      section: "153",
      family: "WITHHOLDING",
      source: String(key).includes("SERVICE") ? "services" : "business",
      subcategory: String(key).toLowerCase(),
      label: String(label),
      atl: percent(Number(atl), String(basis)),
      nonAtl: percent(Number(nonAtl), String(basis)),
    }),
  );
});

// Sections 154 and 154A — Exports (PDF page 7)
[
  ["1", "Section 154(1) export proceeds"],
  ["3-3A-3B-3C", "Section 154(3), (3A), (3B) and (3C) export proceeds"],
].forEach(([key, label]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-154-${key}`,
      page: 7,
      section: "154",
      family: "WITHHOLDING",
      source: "business",
      subcategory: `exports-${String(key).toLowerCase()}`,
      label: String(label),
      atl: percent(1, "EXPORT_PROCEEDS"),
      nonAtl: percent(2, "EXPORT_PROCEEDS"),
    }),
  );
});

rules.push(
  atlNonAtlRule({
    id: "TY2026-154A-EXPORT-SERVICES-PSEB-IT-ITES",
    page: 7,
    section: "154A",
    family: "WITHHOLDING",
    source: "services",
    subcategory: "export-it-ites-pseb",
    label: "Exported software/IT/IT-enabled services by a PSEB-registered person",
    atl: percent(0.25, "EXPORT_PROCEEDS"),
    nonAtl: percent(0.5, "EXPORT_PROCEEDS"),
    condition: { attributes: { psebRegistered: true, taxYearMaxInclusive: 2026 } },
  }),
  atlNonAtlRule({
    id: "TY2026-154A-EXPORT-SERVICES-OTHER",
    page: 7,
    section: "154A",
    family: "WITHHOLDING",
    source: "services",
    subcategory: "export-services-other",
    label: "Other export-of-services case",
    atl: percent(1, "EXPORT_PROCEEDS"),
    nonAtl: percent(2, "EXPORT_PROCEEDS"),
  }),
);

// Section 155 — Rent of immovable property (PDF page 7)
[
  ["INDIVIDUAL-AOP-UP-TO-300K", 0, 300_000, zero()],
  ["INDIVIDUAL-AOP-300K-600K", 300_000, 600_000, marginal(0, 5, 300_000, "GROSS_RENT")],
  ["INDIVIDUAL-AOP-600K-2M", 600_000, 2_000_000, marginal(15_000, 10, 600_000, "GROSS_RENT")],
  ["INDIVIDUAL-AOP-ABOVE-2M", 2_000_000, null, marginal(155_000, 25, 2_000_000, "GROSS_RENT")],
].forEach(([key, lower, upper, value]) => {
  rules.push(
    rule({
      id: `TY2026-155-RENT-${key}`,
      page: 7,
      section: "155",
      family: "WITHHOLDING",
      source: "property_rent",
      subcategory: "individual-aop",
      label: `Individual/AOP rent band ${String(key).toLowerCase()}`,
      condition: {
        amount: {
          field: "grossRent",
          ...(Number(lower) === 0 ? { minInclusive: 0 } : { minExclusive: Number(lower) }),
          ...(upper === null ? {} : { maxInclusive: Number(upper) }),
        },
        attributes: { taxpayerKind: "INDIVIDUAL_OR_AOP" },
      },
      rates: { DEFAULT: value as RateCardValue },
    }),
  );
});

rules.push(
  atlNonAtlRule({
    id: "TY2026-155-RENT-COMPANY",
    page: 7,
    section: "155",
    family: "WITHHOLDING",
    source: "property_rent",
    subcategory: "company",
    label: "Rent paid to company",
    atl: percent(15, "GROSS_RENT"),
    nonAtl: percent(30, "GROSS_RENT"),
    condition: { attributes: { taxpayerKind: "COMPANY" } },
  }),
);

// Sections 156 and 156A — Prizes and petroleum products (PDF pages 7–8)
rules.push(
  atlNonAtlRule({
    id: "TY2026-156-PRIZE-BOND-CROSSWORD",
    page: 7,
    section: "156",
    family: "WITHHOLDING",
    source: "other_income",
    subcategory: "prize-bond-crossword",
    label: "Prize bond or crossword puzzle winnings",
    atl: percent(15, "GROSS_WINNINGS"),
    nonAtl: percent(30, "GROSS_WINNINGS"),
  }),
  atlNonAtlRule({
    id: "TY2026-156-RAFFLE-LOTTERY-QUIZ-SALES-PROMOTION",
    page: 8,
    section: "156",
    family: "WITHHOLDING",
    source: "other_income",
    subcategory: "raffle-lottery-quiz-sales-promotion",
    label: "Raffle, lottery, quiz or company sales-promotion prize",
    atl: percent(20, "GROSS_WINNINGS"),
    nonAtl: percent(40, "GROSS_WINNINGS"),
  }),
  atlNonAtlRule({
    id: "TY2026-156A-PETROLEUM-PRODUCT-SALE",
    page: 8,
    section: "156A",
    family: "WITHHOLDING",
    source: "business",
    subcategory: "petroleum-product-sale",
    label: "Sale of petroleum products",
    atl: percent(12, "GROSS_SALE"),
    nonAtl: percent(24, "GROSS_SALE"),
  }),
);

// Section 231AB — Cash withdrawal (PDF page 8)
rules.push(
  rule({
    id: "TY2026-231AB-CASH-WITHDRAWAL-NON-ATL",
    page: 8,
    section: "231AB",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "cash-withdrawal",
    label: "Cash withdrawal by a person not appearing in ATL",
    condition: { attributes: { taxpayerStatus: "NON_ATL" } },
    rates: {
      ATL: notApplicable(),
      NON_ATL: percent(0.8, "CASH_WITHDRAWAL_AMOUNT"),
    },
  }),
);

// Section 231B — Motor vehicles (PDF pages 8–10)
const vehicleValueBands = [
  ["UP-TO-850CC", 0, 850, 0.5, 1.5],
  ["851-1000CC", 851, 1000, 1, 3],
  ["1001-1300CC", 1001, 1300, 1.5, 4.5],
  ["1301-1600CC", 1301, 1600, 2, 6],
  ["1601-1800CC", 1601, 1800, 3, 9],
  ["1801-2000CC", 1801, 2000, 5, 15],
  ["2001-2500CC", 2001, 2500, 7, 21],
  ["2501-3000CC", 2501, 3000, 9, 27],
  ["ABOVE-3000CC", 3001, null, 12, 36],
] as const;

vehicleValueBands.forEach(([key, minCc, maxCc, atl, nonAtl], index) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-231B-1-3-${key}`,
      page: index < 8 ? 8 : 9,
      section: "231B",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "motor-vehicle-value",
      label: `Motor vehicle under Section 231B(1)/(3) — ${key.toLowerCase()}`,
      atl: percent(atl, "VEHICLE_VALUE"),
      nonAtl: percent(nonAtl, "VEHICLE_VALUE"),
      condition: {
        amount: {
          field: "engineCapacityCc",
          minInclusive: minCc,
          ...(maxCc === null ? {} : { maxInclusive: maxCc }),
        },
      },
      notes: [
        "Vehicle value follows the import, local invoice or auction-value definition in PDF endnote 1.",
      ],
    }),
  );
});

const vehicleFixedBands231B2 = [
  ["UP-TO-850CC", 0, 850, 0, 0],
  ["851-1000CC", 851, 1000, 5_000, 15_000],
  ["1001-1300CC", 1001, 1300, 7_500, 22_500],
  ["1301-1600CC", 1301, 1600, 12_500, 37_500],
  ["1601-1800CC", 1601, 1800, 18_750, 56_250],
  ["1801-2000CC", 1801, 2000, 25_000, 75_000],
  ["2001-2500CC", 2001, 2500, 37_500, 112_500],
  ["2501-3000CC", 2501, 3000, 50_000, 150_000],
  ["ABOVE-3000CC", 3001, null, 62_500, 187_500],
] as const;

vehicleFixedBands231B2.forEach(([key, minCc, maxCc, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-231B-2-${key}`,
      page: 9,
      section: "231B",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "motor-vehicle-section-231b-2",
      label: `Motor vehicle under Section 231B(2) — ${key.toLowerCase()}`,
      atl: atl === 0 ? zero() : fixed(atl),
      nonAtl: nonAtl === 0 ? zero() : fixed(nonAtl),
      condition: {
        amount: {
          field: "engineCapacityCc",
          minInclusive: minCc,
          ...(maxCc === null ? {} : { maxInclusive: maxCc }),
        },
      },
    }),
  );
});

[
  ["UP-TO-1000CC", 0, 1000, 100_000, 300_000],
  ["1001-2000CC", 1001, 2000, 200_000, 600_000],
  ["ABOVE-2000CC", 2001, null, 400_000, 1_200_000],
].forEach(([key, minCc, maxCc, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-231B-2A-${key}`,
      page: Number(minCc) <= 1000 ? 9 : 10,
      section: "231B",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "motor-vehicle-section-231b-2a",
      label: `Motor vehicle under Section 231B(2A) — ${String(key).toLowerCase()}`,
      atl: fixed(Number(atl)),
      nonAtl: fixed(Number(nonAtl)),
      condition: {
        amount: {
          field: "engineCapacityCc",
          minInclusive: Number(minCc),
          ...(maxCc === null ? {} : { maxInclusive: Number(maxCc) }),
        },
      },
    }),
  );
});

rules.push(
  rule({
    id: "TY2026-231B-ENDNOTE-1-NON-CC-VEHICLE-5M-OR-MORE",
    page: 14,
    section: "231B",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "motor-vehicle-non-cc-value-5m-or-more",
    label: "Vehicle without applicable engine capacity and value of PKR 5 million or more",
    condition: {
      amount: { field: "vehicleValue", minInclusive: 5_000_000 },
      attributes: { engineCapacityApplicable: false },
    },
    rates: { DEFAULT: percent(3, "VEHICLE_VALUE") },
    notes: ["Non-ATL pays 9%: the Tenth Schedule proviso raises all Section 231B collection by 200% (Moore Shekha Mufti charts the same 3%/9% split)."],
  }),
  rule({
    id: "TY2026-231B-ENDNOTE-2-NON-CC-VEHICLE-FIXED",
    page: 14,
    section: "231B",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "motor-vehicle-non-cc-fixed",
    label: "Vehicle without applicable engine capacity and value of PKR 5 million or more",
    condition: {
      amount: { field: "vehicleValue", minInclusive: 5_000_000 },
      attributes: { engineCapacityApplicable: false },
    },
    rates: { DEFAULT: fixed(20_000) },
    notes: [
      "The fixed amount is reduced by 10% for each completed year from first registration in Pakistan (compounded).",
      "Non-ATL pays Rs 60,000: the Tenth Schedule proviso raises all Section 231B collection by 200%.",
    ],
  }),
);

// Sections 231C and 233 (PDF page 10)
rules.push(
  atlNonAtlRule({
    id: "TY2026-231C-FOREIGN-DOMESTIC-WORKER",
    page: 10,
    section: "231C",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "foreign-domestic-worker",
    label: "Advance tax on a foreign domestic worker",
    atl: fixed(200_000),
    nonAtl: fixed(400_000),
  }),
);

[
  ["ADVERTISING-AGENT", "Advertising agent", 10, 20],
  ["LIFE-INSURANCE-AGENT-BELOW-500K", "Life-insurance agent receiving below PKR 500,000 per year", 8, 16],
  ["OTHER", "Brokerage or commission — other person", 12, 24],
].forEach(([key, label, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-233-${key}`,
      page: 10,
      section: "233",
      family: "WITHHOLDING",
      source: "other_income",
      subcategory: `brokerage-commission-${String(key).toLowerCase()}`,
      label: String(label),
      atl: percent(Number(atl), "GROSS_BROKERAGE_OR_COMMISSION"),
      nonAtl: percent(Number(nonAtl), "GROSS_BROKERAGE_OR_COMMISSION"),
    }),
  );
});

// Section 234 — Tax on motor vehicles (PDF pages 10–11)
rules.push(
  rule({
    id: "TY2026-234-GOODS-TRANSPORT-PER-KG",
    page: 10,
    section: "234",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "goods-transport-vehicle",
    label: "Goods transport vehicle by laden weight",
    rates: { DEFAULT: perUnit(2.5, "KG_LADEN_WEIGHT") },
    notes: [
      "PDF endnote 3 describes a historical non-increase period ending 30 June 2023; no separate TY2026 rate is supplied by that endnote.",
    ],
  }),
  rule({
    id: "TY2026-234-GOODS-TRANSPORT-ABOVE-8120-KG",
    page: 10,
    section: "234",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "goods-transport-vehicle-above-8120kg",
    label: "Goods transport vehicle above 8,120 kg laden weight",
    condition: {
      amount: { field: "ladenWeightKg", minExclusive: 8_120 },
    },
    rates: { DEFAULT: fixed(1_200, "YEAR") },
  }),
);

[
  ["4-9-PERSONS", 4, 9, 200, 375],
  ["10-19-PERSONS", 10, 19, 500, 750],
  ["20-OR-MORE-PERSONS", 20, null, 1_000, 1_500],
].forEach(([key, minSeats, maxSeats, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-234-PASSENGER-${key}`,
      page: 10,
      section: "234",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "passenger-transport-per-seat",
      label: `Passenger transport vehicle — ${String(key).toLowerCase()}`,
      atl: fixed(Number(atl), "SEAT"),
      nonAtl: fixed(Number(nonAtl), "SEAT"),
      condition: {
        amount: {
          field: "seatCount",
          minInclusive: Number(minSeats),
          ...(maxSeats === null ? {} : { maxInclusive: Number(maxSeats) }),
        },
      },
    }),
  );
});

const section234AnnualVehicleBands = [
  ["UP-TO-1000CC", 0, 1000, 800, 1_600],
  ["1001-1199CC", 1001, 1199, 1_500, 3_000],
  ["1200-1299CC", 1200, 1299, 1_750, 3_500],
  ["1300-1499CC", 1300, 1499, 2_500, 5_000],
  ["1500-1599CC", 1500, 1599, 3_750, 7_500],
  ["1600-1999CC", 1600, 1999, 4_500, 9_000],
  ["2000CC-OR-MORE", 2000, null, 10_000, 20_000],
] as const;

section234AnnualVehicleBands.forEach(([key, minCc, maxCc, atl, nonAtl], index) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-234-ANNUAL-${key}`,
      page: index === 0 ? 10 : 11,
      section: "234",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "motor-vehicle-annual",
      label: `Annual motor-vehicle tax — ${key.toLowerCase()}`,
      atl: fixed(atl),
      nonAtl: fixed(nonAtl),
      condition: {
        amount: {
          field: "engineCapacityCc",
          minInclusive: minCc,
          ...(maxCc === null ? {} : { maxInclusive: maxCc }),
        },
      },
    }),
  );
});

const section234LumpSumVehicleBands = [
  ["UP-TO-1000CC", 0, 1000, 10_000, 20_000],
  ["1001-1199CC", 1001, 1199, 18_000, 36_000],
  ["1200-1299CC", 1200, 1299, 20_000, 40_000],
  ["1300-1499CC", 1300, 1499, 30_000, 60_000],
  ["1500-1599CC", 1500, 1599, 45_000, 90_000],
  ["1600-1999CC", 1600, 1999, 60_000, 120_000],
  ["2000CC-OR-MORE", 2000, null, 120_000, 240_000],
] as const;

section234LumpSumVehicleBands.forEach(([key, minCc, maxCc, atl, nonAtl]) => {
  rules.push(
    atlNonAtlRule({
      id: `TY2026-234-LUMP-SUM-${key}`,
      page: 11,
      section: "234",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "motor-vehicle-lump-sum",
      label: `Lump-sum motor-vehicle tax — ${key.toLowerCase()}`,
      atl: fixed(atl),
      nonAtl: fixed(nonAtl),
      condition: {
        amount: {
          field: "engineCapacityCc",
          minInclusive: minCc,
          ...(maxCc === null ? {} : { maxInclusive: maxCc }),
        },
      },
    }),
  );
});

// Section 235 — Electricity consumption (PDF pages 11–12)
rules.push(
  rule({
    id: "TY2026-235-COMMERCIAL-INDUSTRIAL-UP-TO-500",
    page: 11,
    section: "235",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "electricity-commercial-industrial",
    label: "Commercial/industrial electricity bill up to PKR 500",
    condition: {
      amount: { field: "grossBill", minInclusive: 0, maxInclusive: 500 },
    },
    rates: { DEFAULT: zero() },
  }),
  rule({
    id: "TY2026-235-COMMERCIAL-INDUSTRIAL-500-20K",
    page: 12,
    section: "235",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "electricity-commercial-industrial",
    label: "Commercial/industrial electricity bill above PKR 500 and up to PKR 20,000",
    condition: {
      amount: { field: "grossBill", minExclusive: 500, maxInclusive: 20_000 },
    },
    rates: { DEFAULT: percent(10, "GROSS_BILL") },
  }),
  rule({
    id: "TY2026-235-COMMERCIAL-ABOVE-20K",
    page: 12,
    section: "235",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "electricity-commercial",
    label: "Commercial electricity bill above PKR 20,000",
    condition: {
      amount: { field: "grossBill", minExclusive: 20_000 },
      attributes: { consumerType: "COMMERCIAL" },
    },
    rates: { DEFAULT: marginal(1_950, 12, 20_000, "GROSS_BILL") },
  }),
  rule({
    id: "TY2026-235-INDUSTRIAL-ABOVE-20K",
    page: 12,
    section: "235",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "electricity-industrial",
    label: "Industrial electricity bill above PKR 20,000",
    condition: {
      amount: { field: "grossBill", minExclusive: 20_000 },
      attributes: { consumerType: "INDUSTRIAL" },
    },
    rates: { DEFAULT: marginal(1_950, 5, 20_000, "GROSS_BILL") },
  }),
  rule({
    id: "TY2026-235-DOMESTIC-NON-ATL-BELOW-25K",
    page: 12,
    section: "235",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "electricity-domestic-non-atl",
    label: "Non-ATL domestic electricity bill below PKR 25,000",
    condition: {
      amount: { field: "monthlyBill", minInclusive: 0, maxExclusive: 25_000 },
      attributes: { taxpayerStatus: "NON_ATL", consumerType: "DOMESTIC" },
    },
    // The card row covers non-ATL domestic consumers only; an ATL consumer
    // is outside the row, so the status is explicit rather than absent.
    rates: { ATL: notApplicable(), NON_ATL: zero() },
  }),
  rule({
    id: "TY2026-235-DOMESTIC-NON-ATL-25K-OR-MORE",
    page: 12,
    section: "235",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "electricity-domestic-non-atl",
    label: "Non-ATL domestic electricity bill of PKR 25,000 or more",
    condition: {
      amount: { field: "monthlyBill", minInclusive: 25_000 },
      attributes: { taxpayerStatus: "NON_ATL", consumerType: "DOMESTIC" },
    },
    rates: {
      ATL: notApplicable(),
      NON_ATL: percent(7.5, "MONTHLY_BILL"),
    },
  }),
);

// Section 236 — Telephone and internet (PDF page 12)
rules.push(
  rule({
    id: "TY2026-236-LANDLINE-BILL-ABOVE-1000",
    page: 12,
    section: "236",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "landline-telephone",
    label: "Non-mobile telephone bill above PKR 1,000",
    condition: {
      amount: { field: "monthlyBill", minExclusive: 1_000 },
    },
    rates: { DEFAULT: marginal(0, 10, 1_000, "MONTHLY_BILL") },
  }),
  rule({
    id: "TY2026-236-INTERNET-MOBILE-PREPAID",
    page: 12,
    section: "236",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "internet-mobile-prepaid",
    label: "Internet, mobile telephone and prepaid internet/telephone",
    rates: { DEFAULT: percent(15, "BILL_OR_SALE_PRICE") },
  }),
);

// Sections 236A and 236C — Auction and property transfer (PDF pages 12–13)
rules.push(
  atlNonAtlRule({
    id: "TY2026-236A-AUCTION-MOVABLE-OR-OTHER-GOODS",
    page: 12,
    section: "236A",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "public-auction-movable-or-other",
    label: "Public auction of property/goods other than immovable property",
    atl: percent(10, "GROSS_SALE_PRICE"),
    nonAtl: percent(20, "GROSS_SALE_PRICE"),
  }),
  atlNonAtlRule({
    id: "TY2026-236A-AUCTION-IMMOVABLE-OR-RAILWAYS",
    page: 12,
    section: "236A",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "public-auction-immovable-or-railways",
    label: "Auction of immovable property or Pakistan Railways train-management services",
    atl: percent(5, "GROSS_SALE_PRICE"),
    nonAtl: percent(10, "GROSS_SALE_PRICE"),
  }),
);

[
  ["UP-TO-50M", 0, 50_000_000, 4.5, 11.5, 7.5],
  ["50M-100M", 50_000_000, 100_000_000, 5, 11.5, 8.5],
  ["ABOVE-100M", 100_000_000, null, 5.5, 11.5, 9.5],
].forEach(([key, lower, upper, atl, nonAtl, late]) => {
  rules.push(
    rule({
      id: `TY2026-236C-PROPERTY-TRANSFER-${key}`,
      page: String(key) === "UP-TO-50M" ? 12 : 13,
      section: "236C",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "immovable-property-transfer",
      label: `Transfer of immovable property — ${String(key).toLowerCase()}`,
      condition: {
        amount: {
          field: "grossConsiderationReceived",
          ...(Number(lower) === 0 ? { minInclusive: 0 } : { minExclusive: Number(lower) }),
          ...(upper === null ? {} : { maxInclusive: Number(upper) }),
        },
      },
      rates: {
        ATL: percent(Number(atl), "GROSS_CONSIDERATION_RECEIVED"),
        NON_ATL: percent(Number(nonAtl), "GROSS_CONSIDERATION_RECEIVED"),
        LATE_FILER: percent(Number(late), "GROSS_CONSIDERATION_RECEIVED"),
      },
    }),
  );
});

// Sections 236CA, 236CB, 236G and 236H (PDF page 13)
rules.push(
  rule({
    id: "TY2026-236CA-FOREIGN-TV-SERIAL-EPISODE",
    page: 13,
    section: "236CA",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "foreign-tv-serial",
    label: "Foreign-produced TV drama serial or play",
    rates: { DEFAULT: fixed(1_000_000, "EPISODE") },
  }),
  rule({
    id: "TY2026-236CA-FOREIGN-TV-PLAY-SINGLE-EPISODE",
    page: 13,
    section: "236CA",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "foreign-tv-play-single-episode",
    label: "Foreign-produced TV play — single episode",
    rates: { DEFAULT: fixed(3_000_000) },
  }),
  rule({
    id: "TY2026-236CA-ADVERTISEMENT-FOREIGN-ACTOR",
    page: 13,
    section: "236CA",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "advertisement-foreign-actor",
    label: "Advertisement starring a foreign actor",
    rates: { DEFAULT: fixed(100_000, "SECOND") },
  }),
  atlNonAtlRule({
    id: "TY2026-236CB-FUNCTION-GATHERING",
    page: 13,
    section: "236CB",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "function-gathering",
    label: "Bill for arranging or holding a function/gathering",
    atl: percent(10, "TOTAL_BILL"),
    nonAtl: percent(20, "TOTAL_BILL"),
  }),
  atlNonAtlRule({
    id: "TY2026-236G-SALE-FERTILIZER",
    page: 13,
    section: "236G",
    family: "ADVANCE_TAX",
    source: "business",
    subcategory: "sale-to-distributor-fertilizer",
    label: "Fertilizer sales to distributor, dealer or wholesaler",
    atl: percent(0.25, "GROSS_SALE"),
    nonAtl: percent(0.7, "GROSS_SALE"),
  }),
  atlNonAtlRule({
    id: "TY2026-236G-SALE-OTHER",
    page: 13,
    section: "236G",
    family: "ADVANCE_TAX",
    source: "business",
    subcategory: "sale-to-distributor-other",
    label: "Other sales to distributor, dealer or wholesaler",
    atl: percent(0.1, "GROSS_SALE"),
    nonAtl: percent(2, "GROSS_SALE"),
  }),
  atlNonAtlRule({
    id: "TY2026-236H-SALE-TO-RETAILER",
    page: 13,
    section: "236H",
    family: "ADVANCE_TAX",
    source: "business",
    subcategory: "sale-to-retailer",
    label: "Sales to retailers",
    atl: percent(0.5, "GROSS_SALE"),
    nonAtl: percent(2.5, "GROSS_SALE"),
  }),
);

// Sections 236K, 236Y and 236Z (PDF pages 13–14)
[
  ["UP-TO-50M", 0, 50_000_000, 1.5, 10.5, 4.5],
  ["50M-100M", 50_000_000, 100_000_000, 2, 14.5, 5.5],
  ["ABOVE-100M", 100_000_000, null, 2.5, 18.5, 6.5],
].forEach(([key, lower, upper, atl, nonAtl, late]) => {
  rules.push(
    rule({
      id: `TY2026-236K-PROPERTY-PURCHASE-${key}`,
      page: 13,
      section: "236K",
      family: "ADVANCE_TAX",
      source: "advance_tax",
      subcategory: "immovable-property-purchase",
      label: `Purchase of immovable property — ${String(key).toLowerCase()}`,
      condition: {
        amount: {
          field: "fairMarketValue",
          ...(Number(lower) === 0 ? { minInclusive: 0 } : { minExclusive: Number(lower) }),
          ...(upper === null ? {} : { maxInclusive: Number(upper) }),
        },
      },
      rates: {
        ATL: percent(Number(atl), "FAIR_MARKET_VALUE"),
        NON_ATL: percent(Number(nonAtl), "FAIR_MARKET_VALUE"),
        LATE_FILER: percent(Number(late), "FAIR_MARKET_VALUE"),
      },
    }),
  );
});

rules.push(
  atlNonAtlRule({
    id: "TY2026-236Y-CARD-REMITTANCE-ABROAD",
    page: 14,
    section: "236Y",
    family: "ADVANCE_TAX",
    source: "advance_tax",
    subcategory: "card-remittance-abroad",
    label: "Amount remitted abroad through credit, debit or prepaid card",
    atl: percent(5, "AMOUNT_REMITTED"),
    nonAtl: percent(10, "AMOUNT_REMITTED"),
  }),
  atlNonAtlRule({
    id: "TY2026-236Z-BONUS-SHARES",
    page: 14,
    section: "236Z",
    family: "ADVANCE_TAX",
    source: "dividend",
    subcategory: "bonus-shares",
    label: "Bonus shares issued by companies",
    atl: percent(10, "VALUE_OF_BONUS_SHARES"),
    nonAtl: percent(20, "VALUE_OF_BONUS_SHARES"),
  }),
);

export const TY2026_RATE_CARD_RULES: ReadonlyArray<RateCardRule> = rules;

export const TY2026_RATE_CARD_SECTION_IDS = [
  "148",
  "149",
  "149(IA)",
  "150",
  "151",
  "151A",
  "152",
  "153",
  "154",
  "154A",
  "155",
  "156",
  "156A",
  "231AB",
  "231B",
  "231C",
  "233",
  "234",
  "235",
  "236",
  "236A",
  "236C",
  "236CA",
  "236CB",
  "236G",
  "236H",
  "236K",
  "236Y",
  "236Z",
] as const;

export function getTy2026RateCardRule(ruleId: string) {
  return TY2026_RATE_CARD_RULES.find((candidate) => candidate.id === ruleId) ?? null;
}

export function getTy2026RateCardRulesForSource(source: string) {
  return TY2026_RATE_CARD_RULES.filter((candidate) => candidate.source === source);
}

export function getTy2026RateCardRulesForSection(section: string) {
  return TY2026_RATE_CARD_RULES.filter((candidate) => candidate.section === section);
}
