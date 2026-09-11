import type { TaxIncomeSource, TaxReadinessItem } from "./filing-drafts";

// Demo stand-in for your real `@/lib/tax/document-requirements` module.
// Real logic differs; this reproduces the shape/behaviour closely enough
// for the wizard's live document checklist to feel real.

const DOC_MAP: Record<
  TaxIncomeSource,
  { documentType: string; label: string; reason: string }[]
> = {
  imports: [
    {
      documentType: "import_tax_document",
      label: "Import / Customs Tax Documents",
      reason: "Required for Section 148 import categories.",
    },
  ],
  salary: [
    {
      documentType: "salary_certificate",
      label: "Salary Certificate",
      reason: "Required for salary income and Section 149 tax-deducted evidence; the mapped amount feeds IRIS Tax Deductions row 64020004.",
    },
  ],
  pension: [
    {
      documentType: "pension_statement",
      label: "Pension Statement",
      reason: "Required for pension income.",
    },
  ],
  property_rent: [
    {
      documentType: "rent_agreement",
      label: "Rent Agreement / Receipts",
      reason: "Required for rental income.",
    },
  ],
  services: [
    {
      documentType: "invoice_summary",
      label: "Invoices / Service Income Summary",
      reason: "Required for freelance/services income.",
    },
  ],
  bank_profit: [
    {
      documentType: "bank_certificate",
      label: "Bank Profit Certificate",
      reason: "Required for bank profit income.",
    },
  ],
  dividend: [
    {
      documentType: "dividend_certificate",
      label: "Dividend Certificate",
      reason: "Required for dividend income.",
    },
  ],
  capital_gains: [
    {
      documentType: "cgt_statement",
      label: "Capital Gains Statement",
      reason: "Required for capital gains.",
    },
  ],
  business: [
    {
      documentType: "business_books",
      label: "Business Books / Sales Records",
      reason: "Required for business income.",
    },
  ],
  agriculture: [
    {
      documentType: "agri_record",
      label: "Agriculture Income Record",
      reason: "Required for agriculture income.",
    },
  ],
  foreign_income_assets: [
    {
      documentType: "foreign_asset_statement",
      label: "Foreign Asset / Income Statement",
      reason: "Required for foreign income or assets.",
    },
  ],
  aop_company_links: [
    {
      documentType: "aop_company_proof",
      label: "AOP / Company Membership Proof",
      reason: "Required for AOP or company links.",
    },
  ],
  sales_tax_fed_withholding: [
    {
      documentType: "sales_tax_return",
      label: "Sales Tax / FED Return",
      reason: "Required for indirect tax obligations.",
    },
  ],
  other_income: [
    {
      documentType: "other_income_proof",
      label: "Other Income Proof",
      reason: "Required for miscellaneous income.",
    },
  ],
  advance_tax: [
    {
      documentType: "advance_tax_evidence",
      label: "Advance Tax Evidence / CPR",
      reason: "Required for selected TY2026 advance-tax transactions.",
    },
  ],
};

const CORE_DOCS = [
  {
    documentType: "cnic",
    label: "CNIC Copy",
    reason: "Always required for identity verification.",
  },
  {
    documentType: "bank_statement",
    label: "Bank Statement (12 months)",
    reason: "Used for wealth reconciliation (Mizan).",
  },
];

export function buildTaxDocumentSlotsPreview(input: {
  incomeSources: TaxIncomeSource[];
  readinessCompleted: TaxReadinessItem[];
}) {
  const requiredTypes = new Set(
    getRequiredTaxDocumentTypesForCurrentFlow({
      incomeSources: input.incomeSources,
    }),
  );

  const slots = [
    ...CORE_DOCS.map((d) => ({ ...d, required: true })),
    ...input.incomeSources.flatMap(
      (source) =>
        DOC_MAP[source]?.map((d) => ({
          ...d,
          required: requiredTypes.has(d.documentType),
        })) ?? [],
    ),
  ];

  // De-duplicate by documentType
  const seen = new Set<string>();
  return slots.filter((slot) => {
    if (seen.has(slot.documentType)) return false;
    seen.add(slot.documentType);
    return true;
  });
}

export function getRequiredTaxDocumentTypesForCurrentFlow(input: {
  incomeSources: TaxIncomeSource[];
}) {
  const required = new Set<string>(CORE_DOCS.map((d) => d.documentType));
  for (const source of input.incomeSources) {
    for (const doc of DOC_MAP[source] ?? []) required.add(doc.documentType);
  }
  return Array.from(required);
}
