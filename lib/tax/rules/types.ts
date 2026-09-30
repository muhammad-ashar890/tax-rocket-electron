export type TaxSlab = {
  upperLimit: number | null;
  baseTax: number;
  rate: number;
  lowerLimit: number;
};

export type SalaryTaxRules = {
  taxYear: number;
  source: string;
  salarySlabs: TaxSlab[];
  surchargeAbove?: number;
  surchargeRate?: number;
};

export type PensionTaxRules = {
  taxYear: number;
  source: string;
  exemptUpTo: number;
  aboveExemptRate?: number;
  surchargeRate?: number;
};

export type RentalTaxRules = {
  taxYear: number;
  source: string;
  individualSlabs: TaxSlab[];
};
