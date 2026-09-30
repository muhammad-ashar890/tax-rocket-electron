import { TY2026_RATE_CARD_RULES } from "./catalog";
import type { RateCardRule } from "../rate-card-types";

export type Ty2026CatalogSource =
  | "imports"
  | "salary"
  | "pension"
  | "dividend"
  | "bank_profit"
  | "capital_gains"
  | "foreign_income_assets"
  | "business"
  | "services"
  | "property_rent"
  | "other_income"
  | "advance_tax";

export type Ty2026SubcategoryStepKey =
  | "subcategory_imports"
  | "subcategory_pension"
  | "subcategory_property_rent"
  | "subcategory_services"
  | "subcategory_bank_profit"
  | "subcategory_dividend"
  | "subcategory_business"
  | "subcategory_foreign_income_assets"
  | "subcategory_other_income"
  | "subcategory_advance_tax";

export type Ty2026IncomeSelectionInput = Readonly<{
  source: string;
  subcategory: string;
  details?: Ty2026SelectionUserDetails;
}>;

/**
 * Figures the taxpayer declares on a subcategory card. Income routes read
 * their amounts from the ledger, but activity routes (imports, advance tax)
 * and the composite dividend row need transaction-level inputs — a bill, a
 * vehicle value, an engine capacity, a debt/equity split — that no ledger
 * row carries. Those inputs travel here, are persisted on
 * FilingIncomeSelection.detailsJson beside the rule metadata, and are
 * validated again by the tax-calculation action before pricing.
 */
export type Ty2026SelectionUserDetails = {
  /** Declared transaction base in PKR (bill, value, consideration, ...). */
  amount?: number;
  /** Engine capacity in cc, used to pick vehicle bands. */
  engineCapacityCc?: number;
  /** Seat/person count, used by the per-seat passenger rows. */
  seatCount?: number;
  /** Laden weight in kg, used by the goods-transport rows. */
  ladenWeightKg?: number;
  /** Unit count for per-unit rows (workers, episodes, seconds). */
  unitQuantity?: number;
  /** Completed years since first registration (non-cc transfer taper). */
  vehicleAgeYears?: number;
  /** Customs C&F value in USD, banding mobile-phone imports. */
  cfValueUsd?: number;
  /** Whether an imported handset is a smartphone (matters at $30 or less). */
  isSmartphone?: boolean;
  /** Debt-derived portion of a composite mutual-fund dividend. */
  debtPortion?: number;
  /** Equity-derived portion of a composite mutual-fund dividend. */
  equityPortion?: number;
};

export type Ty2026DetailFieldKey =
  | "amount"
  | "engineCapacityCc"
  | "seatCount"
  | "ladenWeightKg"
  | "unitQuantity"
  | "vehicleAgeYears"
  | "cfValueUsd"
  | "isSmartphone"
  | "debtPortion"
  | "equityPortion";

/**
 * One declared figure a subcategory card asks for. The wizard renders these
 * inputs; the tax-calculation action enforces the required ones. Keeping the
 * metadata here means the UI and the server validate the same contract.
 */
export type Ty2026DetailField = Readonly<{
  key: Ty2026DetailFieldKey;
  label: string;
  hint: string;
  required: boolean;
  /** Inclusive floor; values below it are rejected at calculation. */
  min: number;
  /** Whole-number input (counts, cc, seats) versus a money input. */
  wholeNumber: boolean;
  /**
   * Renders a yes/no checkbox instead of a number input. Only isSmartphone
   * uses this today; required still means "must be answered".
   */
  checkbox?: boolean;
}>;

export type Ty2026SubcategoryOption = Readonly<{
  source: Ty2026CatalogSource;
  subcategory: string;
  label: string;
  sections: readonly string[];
  ruleIds: readonly string[];
  ruleCount: number;
  implementationStatus: "CATALOGUED" | "NEEDS_EXTERNAL_DETAIL";
}>;

export type Ty2026SubcategoryStepDefinition = Readonly<{
  key: Ty2026SubcategoryStepKey;
  source: Ty2026CatalogSource;
  title: string;
  railLabel: string;
  description: string;
}>;

export const TY2026_SUBCATEGORY_STEPS: readonly Ty2026SubcategoryStepDefinition[] =
  [
    {
      key: "subcategory_imports",
      source: "imports",
      title: "Which import categories apply?",
      railLabel: "Import categories",
      description:
        "Select every TY2026 import category that applies. You can choose more than one.",
    },
    {
      key: "subcategory_pension",
      source: "pension",
      title: "Which pension situations apply?",
      railLabel: "Pension categories",
      description:
        "Optional - skip if none apply. Amount and age bands are calculated automatically from your pension records and date of birth.",
    },
    {
      key: "subcategory_property_rent",
      source: "property_rent",
      title: "Who received the rental income?",
      railLabel: "Rental categories",
      description: "Select the recipient type used by the TY2026 rental rules.",
    },
    {
      key: "subcategory_services",
      source: "services",
      title: "What type of services income was received?",
      railLabel: "Services categories",
      description:
        "Select all local, IT, advertising, exporter or export-service categories that apply.",
    },
    {
      key: "subcategory_bank_profit",
      source: "bank_profit",
      title: "What type of profit on debt was received?",
      railLabel: "Bank-profit categories",
      description:
        "Select every bank deposit, security, other profit-on-debt or Sukuk category that applies.",
    },
    {
      key: "subcategory_dividend",
      source: "dividend",
      title: "What type of dividend was received?",
      railLabel: "Dividend categories",
      description:
        "Select each dividend payer or fund category shown on the supporting documents.",
    },
    {
      key: "subcategory_business",
      source: "business",
      title: "Which business transaction categories apply?",
      railLabel: "Business categories",
      description:
        "Select all supply, contract, e-commerce, export and distribution categories that apply.",
    },
    {
      key: "subcategory_foreign_income_assets",
      source: "foreign_income_assets",
      title: "Which non-resident payment categories apply?",
      railLabel: "Non-resident categories",
      description:
        "Select every Section 152 payment or service category relevant to the filing.",
    },
    {
      key: "subcategory_other_income",
      source: "other_income",
      title: "What type of other income was received?",
      railLabel: "Other-income categories",
      description:
        "Select all prize, brokerage or commission categories that apply.",
    },
    {
      key: "subcategory_advance_tax",
      source: "advance_tax",
      title: "Which advance-tax transactions apply?",
      railLabel: "Advance-tax categories",
      description:
        "Select all vehicle, utility, property, auction, remittance or other advance-tax categories that apply.",
    },
  ] as const;

const SOURCE_BY_STEP = new Map<Ty2026SubcategoryStepKey, Ty2026CatalogSource>(
  TY2026_SUBCATEGORY_STEPS.map((step) => [step.key, step.source]),
);

const STEP_BY_SOURCE = new Map<
  Ty2026CatalogSource,
  Ty2026SubcategoryStepDefinition
>(TY2026_SUBCATEGORY_STEPS.map((step) => [step.source, step]));

const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "property_rent:individual-aop": "Rent received by an individual or AOP",
  "property_rent:company": "Rent received by a company",
  "advance_tax:motor-vehicle-value":
    "Motor vehicle purchase/registration",
  "advance_tax:motor-vehicle-section-231b-2":
    "Motor vehicle transfer",
  "advance_tax:motor-vehicle-section-231b-2a":
    "Motor vehicle lease",
  "advance_tax:passenger-transport-per-seat":
    "Passenger transport vehicle — per-seat tax",
  "advance_tax:motor-vehicle-annual": "Annual motor-vehicle tax",
  "advance_tax:motor-vehicle-lump-sum": "Lump-sum motor-vehicle tax",
  "advance_tax:electricity-commercial-industrial":
    "Commercial/industrial electricity bill up to PKR 20,000",
  "advance_tax:electricity-domestic-non-atl":
    "Domestic electricity bill — Non-ATL",
  "advance_tax:immovable-property-transfer":
    "Transfer/sale of immovable property",
  "advance_tax:immovable-property-purchase": "Purchase of immovable property",
};

const AUTOMATIC_SUBCATEGORIES: Readonly<
  Partial<Record<Ty2026CatalogSource, readonly string[]>>
> = {
  salary: ["salary", "salary-surcharge"],
  capital_gains: ["certain-debt-securities"],
};

const pkrAmount = (label: string, hint: string): Ty2026DetailField => ({
  key: "amount",
  label,
  hint,
  required: true,
  min: 0,
  wholeNumber: false,
});

const ENGINE_CC_FIELD: Ty2026DetailField = {
  key: "engineCapacityCc",
  label: "Engine capacity (cc)",
  hint: "As on the registration book. Non-cc/electric vehicles use the non-cc card.",
  required: true,
  min: 1,
  wholeNumber: true,
};

const VEHICLE_AGE_YEARS_FIELD: Ty2026DetailField = {
  key: "vehicleAgeYears",
  label: "Completed years since first registration",
  hint: "Whole years from first registration in Pakistan. Enter 0 for the first year; the charge falls 10% per year.",
  required: true,
  min: 0,
  wholeNumber: true,
};

/**
 * Declared figures per selectable card, keyed by `source:subcategory`. Cards
 * absent here need no figures: income-route cards read the ledger, the
 * single-episode TV-play row is a fixed charge, and the intentionally
 * unpriced rows stop with NEEDS_RULES however much is declared.
 */
const DETAIL_FIELDS_BY_SELECTION: Readonly<
  Record<string, readonly Ty2026DetailField[]>
> = {
  // Section 148 — every priced import row is a percentage of import value.
  "imports:part-i": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-ii": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-ii-commercial": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-iii": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-iii-commercial": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:sro-1125-manufacturer": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:pharma": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:ev-ckd": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  // Section 148 mobiles — fixed charge by C&F value band (Ordinance
  // First Schedule Part-II). The PKR base is irrelevant to the charge, so
  // only the banding inputs are collected.
  "imports:mobile-pct-8517-1219": [
    {
      key: "cfValueUsd",
      label: "C&F value (USD)",
      hint: "Customs cost-and-freight value in US dollars, from the goods declaration.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
    {
      key: "isSmartphone",
      label: "Smartphone?",
      hint: "Needed only when the C&F value is $30 or less on this code.",
      required: false,
      min: 0,
      wholeNumber: false,
      checkbox: true,
    },
  ],
  "imports:mobile-pct-8517-1211": [
    {
      key: "cfValueUsd",
      label: "C&F value (USD)",
      hint: "Customs cost-and-freight value in US dollars, from the goods declaration.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
    {
      key: "isSmartphone",
      label: "Smartphone?",
      hint: "CKD kits pay nothing up to $350, so this rarely matters here.",
      required: false,
      min: 0,
      wholeNumber: false,
      checkbox: true,
    },
  ],
  // Section 231AB — cash withdrawal while not on ATL.
  "advance_tax:cash-withdrawal": [
    pkrAmount("Cash withdrawn (PKR)", "Total cash withdrawn while not on ATL."),
  ],
  // Section 231B — vehicle value bands need the value plus engine capacity;
  // the transfer/lease rows are fixed per cc band.
  "advance_tax:motor-vehicle-value": [
    pkrAmount(
      "Vehicle value (PKR)",
      "Import, invoice or auction value per rate-card endnote 1.",
    ),
    ENGINE_CC_FIELD,
  ],
  "advance_tax:motor-vehicle-section-231b-2": [ENGINE_CC_FIELD],
  "advance_tax:motor-vehicle-section-231b-2a": [ENGINE_CC_FIELD],
  // Section 231B endnotes — non-cc rows need the vehicle value (the Rs 5m
  // threshold); the fixed transfer row also needs completed years since
  // first registration for the 10%-per-year reduction.
  "advance_tax:motor-vehicle-non-cc-value-5m-or-more": [
    pkrAmount(
      "Vehicle value (PKR)",
      "Import, invoice or auction value. The 3% rate applies at Rs 5,000,000 or more.",
    ),
  ],
  "advance_tax:motor-vehicle-non-cc-fixed": [
    pkrAmount(
      "Vehicle value (PKR)",
      "Import, invoice or auction value. The fixed charge applies at Rs 5,000,000 or more.",
    ),
    VEHICLE_AGE_YEARS_FIELD,
  ],
  // Section 231C — fixed per worker.
  "advance_tax:foreign-domestic-worker": [
    {
      key: "unitQuantity",
      label: "Number of workers",
      hint: "The fixed charge applies per foreign domestic worker.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  // Section 234 — goods transport by laden weight, passengers per seat,
  // private vehicles by cc band.
  "advance_tax:goods-transport-vehicle": [
    {
      key: "ladenWeightKg",
      label: "Laden weight (kg)",
      hint: "Charged at Rs 2.50 per kg up to 8,120 kg.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
  ],
  "advance_tax:goods-transport-vehicle-above-8120kg": [
    {
      key: "ladenWeightKg",
      label: "Laden weight (kg)",
      hint: "Must exceed 8,120 kg for the fixed Rs 1,200 row.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
  ],
  "advance_tax:passenger-transport-per-seat": [
    {
      key: "seatCount",
      label: "Seats / persons",
      hint: "The per-seat rows start at 4 persons.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  "advance_tax:motor-vehicle-annual": [ENGINE_CC_FIELD],
  "advance_tax:motor-vehicle-lump-sum": [ENGINE_CC_FIELD],
  // Section 235 — electricity bills.
  "advance_tax:electricity-commercial-industrial": [
    pkrAmount("Bill amount (PKR)", "Gross commercial/industrial bill."),
  ],
  "advance_tax:electricity-commercial": [
    pkrAmount("Bill amount (PKR)", "Gross commercial bill."),
  ],
  "advance_tax:electricity-industrial": [
    pkrAmount("Bill amount (PKR)", "Gross industrial bill."),
  ],
  "advance_tax:electricity-domestic-non-atl": [
    pkrAmount("Monthly bill (PKR)", "Gross domestic bill."),
  ],
  // Section 236 — telephone and internet.
  "advance_tax:landline-telephone": [
    pkrAmount("Monthly bill (PKR)", "Charged on the amount above Rs 1,000."),
  ],
  "advance_tax:internet-mobile-prepaid": [
    pkrAmount(
      "Bill / sale price (PKR)",
      "Bill amount or prepaid card/unit sale price.",
    ),
  ],
  // Sections 236A, 236C, 236K — auction and property transactions.
  "advance_tax:public-auction-movable-or-other": [
    pkrAmount("Gross sale price (PKR)", "Auction sale price."),
  ],
  "advance_tax:public-auction-immovable-or-railways": [
    pkrAmount("Gross sale price (PKR)", "Auction sale price."),
  ],
  "advance_tax:immovable-property-transfer": [
    pkrAmount(
      "Consideration received (PKR)",
      "Gross amount of consideration received.",
    ),
  ],
  "advance_tax:immovable-property-purchase": [
    pkrAmount("Fair market value (PKR)", "Fair market value of the property."),
  ],
  // Section 236CA — foreign TV content is fixed per episode/second.
  "advance_tax:foreign-tv-serial": [
    {
      key: "unitQuantity",
      label: "Number of episodes",
      hint: "Rs 1,000,000 is charged per episode.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  "advance_tax:advertisement-foreign-actor": [
    {
      key: "unitQuantity",
      label: "Duration (seconds)",
      hint: "Rs 100,000 is charged per second.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  // Sections 236CB, 236Y — function bills and card remittances.
  "advance_tax:function-gathering": [
    pkrAmount("Total bill (PKR)", "Bill for arranging/holding the function."),
  ],
  "advance_tax:card-remittance-abroad": [
    pkrAmount("Amount remitted (PKR)", "Amount remitted abroad by card."),
  ],
  // Section 150 — the composite mutual-fund row needs the debt/equity split
  // because each portion is charged at its own percentage.
  "dividend:mutual-fund-proportional": [
    {
      key: "debtPortion",
      label: "Debt-derived portion (PKR)",
      hint: "Must add up with the equity portion to the dividend income.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
    {
      key: "equityPortion",
      label: "Equity-derived portion (PKR)",
      hint: "Must add up with the debt portion to the dividend income.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
  ],
};

export function getTy2026SubcategoryDetailFields(
  source: string,
  subcategory: string,
): readonly Ty2026DetailField[] {
  return DETAIL_FIELDS_BY_SELECTION[`${source}:${subcategory}`] ?? [];
}

const DETAIL_KEYS: readonly Ty2026DetailFieldKey[] = [
  "amount",
  "engineCapacityCc",
  "seatCount",
  "ladenWeightKg",
  "unitQuantity",
  "vehicleAgeYears",
  "cfValueUsd",
  "debtPortion",
  "equityPortion",
];

/** Detail keys that carry a yes/no answer rather than a number. */
const BOOLEAN_DETAIL_KEYS: readonly Ty2026DetailFieldKey[] = ["isSmartphone"];

/**
 * Shape-validates declared figures. Unknown keys are dropped so older
 * payloads keep working; known keys must be finite numbers of zero or more.
 * Required-field enforcement stays with the tax-calculation action, so draft
 * navigation can save an incomplete card and calculation refuses to price it.
 */
function sanitizeSelectionDetails(
  value: unknown,
):
  | { ok: true; details?: Ty2026SelectionUserDetails }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Selection details must be an object" };
  }
  const details: Ty2026SelectionUserDetails = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !(DETAIL_KEYS as readonly string[]).includes(key) &&
      !(BOOLEAN_DETAIL_KEYS as readonly string[]).includes(key)
    ) {
      continue;
    }
    if (entry === undefined || entry === null || entry === "") continue;
    if ((BOOLEAN_DETAIL_KEYS as readonly string[]).includes(key)) {
      if (typeof entry !== "boolean") {
        return {
          ok: false,
          error: `Selection detail "${key}" must be a yes/no answer`,
        };
      }
      // Indexed assignment into a mixed number/boolean record needs the
      // never cast; the key/typeof checks above keep it sound.
      details[key as Ty2026DetailFieldKey] = entry as never;
      continue;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      return {
        ok: false,
        error: `Selection detail "${key}" must be a number of zero or more`,
      };
    }
    details[key as Ty2026DetailFieldKey] = entry as never;
  }
  return {
    ok: true,
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function optionLabel(
  source: string,
  subcategory: string,
  rules: readonly RateCardRule[],
) {
  const override = LABEL_OVERRIDES[`${source}:${subcategory}`];
  if (override) return override;

  const first = rules[0]?.label ?? subcategory.replaceAll("-", " ");
  if (source === "foreign_income_assets") {
    return `Non-resident payment — ${first}`;
  }

  // Several amount-band rules share one subcategory. The amount/engine band
  // is derived from the later record, so a card represents the common route,
  // not one specific slab.
  return first.replace(/\s+[—-]\s+(up-to|above|\d).*/i, "");
}

const OPTIONS_BY_SOURCE = (() => {
  const grouped = new Map<string, RateCardRule[]>();
  for (const rule of TY2026_RATE_CARD_RULES) {
    const key = `${rule.source}\u0000${rule.subcategory}`;
    const existing = grouped.get(key) ?? [];
    existing.push(rule);
    grouped.set(key, existing);
  }

  const bySource = new Map<Ty2026CatalogSource, Ty2026SubcategoryOption[]>();
  for (const rules of grouped.values()) {
    const first = rules[0];
    const source = first.source as Ty2026CatalogSource;
    const option: Ty2026SubcategoryOption = {
      source,
      subcategory: first.subcategory,
      label: optionLabel(source, first.subcategory, rules),
      sections: Array.from(new Set(rules.map((rule) => rule.section))),
      ruleIds: rules.map((rule) => rule.id),
      ruleCount: rules.length,
      implementationStatus: rules.some(
        (rule) => rule.implementationStatus === "NEEDS_EXTERNAL_DETAIL",
      )
        ? "NEEDS_EXTERNAL_DETAIL"
        : "CATALOGUED",
    };
    const sourceOptions = bySource.get(source) ?? [];
    sourceOptions.push(option);
    bySource.set(source, sourceOptions);
  }

  return bySource;
})();

export function isTy2026SubcategoryStepKey(
  value: string,
): value is Ty2026SubcategoryStepKey {
  return SOURCE_BY_STEP.has(value as Ty2026SubcategoryStepKey);
}

export function getTy2026SourceForStep(
  key: Ty2026SubcategoryStepKey,
): Ty2026CatalogSource {
  return SOURCE_BY_STEP.get(key)!;
}

export function getTy2026SubcategoryStep(
  source: string,
): Ty2026SubcategoryStepDefinition | null {
  return STEP_BY_SOURCE.get(source as Ty2026CatalogSource) ?? null;
}

export function getTy2026SubcategoryOptions(
  source: string,
): readonly Ty2026SubcategoryOption[] {
  return OPTIONS_BY_SOURCE.get(source as Ty2026CatalogSource) ?? [];
}

export function getTy2026SubcategoryStepKeys(
  incomeSources: readonly string[],
  taxYear: number,
): Ty2026SubcategoryStepKey[] {
  if (taxYear !== 2026) return [];
  const selected = new Set(incomeSources);
  return TY2026_SUBCATEGORY_STEPS.filter((step) =>
    selected.has(step.source),
  ).map((step) => step.key);
}

export function isTy2026AutomaticIncomeSelection(
  selection: Ty2026IncomeSelectionInput,
) {
  return (
    AUTOMATIC_SUBCATEGORIES[selection.source as Ty2026CatalogSource]?.includes(
      selection.subcategory,
    ) ?? false
  );
}

export function getTy2026AutomaticIncomeSelections(
  incomeSources: readonly string[],
): Ty2026IncomeSelectionInput[] {
  const selections: Ty2026IncomeSelectionInput[] = [];
  for (const source of incomeSources) {
    for (const subcategory of AUTOMATIC_SUBCATEGORIES[
      source as Ty2026CatalogSource
    ] ?? []) {
      selections.push({ source, subcategory });
    }
  }
  return selections;
}

export function resolveTy2026IncomeSelections(input: {
  incomeSources: readonly string[];
  selections: readonly Ty2026IncomeSelectionInput[];
  requireComplete?: boolean;
}) {
  const selectedSources = new Set(input.incomeSources);
  const normalized = new Map<string, Ty2026IncomeSelectionInput>();

  for (const selection of [
    ...input.selections,
    ...getTy2026AutomaticIncomeSelections(input.incomeSources),
  ]) {
    if (!selectedSources.has(selection.source)) {
      return {
        success: false as const,
        error: `Subcategory source ${selection.source} is not selected`,
      };
    }

    const validOption = getTy2026SubcategoryOptions(selection.source).some(
      (option) => option.subcategory === selection.subcategory,
    );
    if (!validOption) {
      return {
        success: false as const,
        error: `Invalid TY2026 subcategory: ${selection.source}/${selection.subcategory}`,
      };
    }

    const sanitized = sanitizeSelectionDetails(selection.details);
    // NOTE: strict:false disables truthiness narrowing on the `ok`
    // discriminant, so compare explicitly (plain `!sanitized.ok` does not
    // narrow and leaves `.error` inaccessible).
    if (sanitized.ok === false) {
      return { success: false as const, error: sanitized.error };
    }

    normalized.set(`${selection.source}\u0000${selection.subcategory}`, {
      source: selection.source,
      subcategory: selection.subcategory,
      ...(sanitized.details ? { details: sanitized.details } : {}),
    });
  }

  if (input.requireComplete !== false) {
    for (const step of TY2026_SUBCATEGORY_STEPS) {
      if (!selectedSources.has(step.source)) continue;
      // Pension bands are auto-derived and the working question is optional.
      if (step.source === "pension") continue;
      const hasSelection = Array.from(normalized.values()).some(
        (selection) => selection.source === step.source,
      );
      if (!hasSelection) {
        return {
          success: false as const,
          error: `Select at least one option under ${step.railLabel}`,
        };
      }
    }
  }

  return {
    success: true as const,
    selections: Array.from(normalized.values()),
  };
}

/**
 * Reads back the taxpayer-declared figures stored on
 * FilingIncomeSelection.detailsJson beside the rule metadata. Defensive:
 * anything unreadable or out of shape yields undefined rather than a
 * half-parsed figure feeding the calculator.
 */
export function parsePersistedSelectionUserDetails(
  detailsJson: string | null,
): Ty2026SelectionUserDetails | undefined {
  if (!detailsJson) return undefined;
  try {
    const payload = JSON.parse(detailsJson) as {
      userDetails?: Record<string, unknown>;
    };
    const raw = payload?.userDetails;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    const picked: Ty2026SelectionUserDetails = {};
    let found = false;
    for (const key of DETAIL_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
      ) {
        picked[key] = value as never;
        found = true;
      }
    }
    for (const key of BOOLEAN_DETAIL_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "boolean") {
        picked[key] = value as never;
        found = true;
      }
    }
    return found ? picked : undefined;
  } catch {
    return undefined;
  }
}

export function getTy2026SelectionDetails(source: string, subcategory: string) {
  const option = getTy2026SubcategoryOptions(source).find(
    (candidate) => candidate.subcategory === subcategory,
  );
  if (!option) return null;
  return {
    taxYear: 2026,
    ruleIds: option.ruleIds,
    sections: option.sections,
    implementationStatus: option.implementationStatus,
  };
}
