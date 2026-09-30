export type RateCardFilerStatus =
  | "DEFAULT"
  | "ATL"
  | "NON_ATL"
  | "LATE_FILER";

export type RateCardRuleFamily =
  | "INCOME"
  | "WITHHOLDING"
  | "ADVANCE_TAX";

export type RateCardImplementationStatus =
  | "CATALOGUED"
  | "NEEDS_EXTERNAL_DETAIL";

export type RateCardAmountCondition = {
  field: string;
  minInclusive?: number;
  minExclusive?: number;
  maxInclusive?: number;
  maxExclusive?: number;
};

export type RateCardCondition = {
  amount?: RateCardAmountCondition;
  attributes?: Record<string, string | number | boolean>;
};

export type RateCardValue =
  | {
      kind: "ZERO";
    }
  | {
      kind: "NOT_APPLICABLE";
    }
  | {
      kind: "PERCENT";
      percent: number;
      basis: string;
    }
  | {
      kind: "MARGINAL";
      baseTax: number;
      percent: number;
      excessOver: number;
      basis: string;
    }
  | {
      kind: "FIXED";
      amount: number;
      per?: string;
    }
  | {
      kind: "PER_UNIT";
      amount: number;
      unit: string;
    }
  | {
      kind: "RANGE";
      minimum: number;
      maximum: number;
      basis: string;
    }
  | {
      kind: "COMPOSITE";
      formula: string;
      components: ReadonlyArray<{
        label: string;
        percent: number;
        basis: string;
      }>;
    }
  | {
      kind: "REFERENCE";
      section: string;
    };

export type RateCardSurcharge = {
  percent: number;
  basis: "CALCULATED_TAX";
};

export type RateCardRule = {
  id: string;
  taxYear: 2026;
  page: number;
  section: string;
  family: RateCardRuleFamily;
  source: string;
  subcategory: string;
  label: string;
  condition?: RateCardCondition;
  rates: Partial<Record<RateCardFilerStatus, RateCardValue>>;
  surcharge?: RateCardSurcharge;
  reference: string;
  implementationStatus: RateCardImplementationStatus;
  notes?: ReadonlyArray<string>;
};
