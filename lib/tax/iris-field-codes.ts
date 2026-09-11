/**
 * IRIS Field Codes extracted from client's IRIS_System_Field_Codes_Extracted.csv
 * 536 rows - source of truth for portalFieldMap
 */

export type IrisFieldDefinition = {
  code: string;
  description: string;
  portalArea: string;
  section: string;
  rowLevel: string;
  tableColumns: string;
};

export const IRIS_CODES = {
  // Employment - Salary
  SALARY_INCOME: { code: "1000", description: "Income from Salary", portalArea: "Employment", section: "Salary", rowLevel: "Summary" },
  SALARY_PAY_WAGES: { code: "1009", description: "Pay, Wages or Other Remuneration", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },
  SALARY_ALLOWANCES: { code: "1049", description: "Allowances", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },
  SALARY_PENSION_ANNUITY: { code: "1008", description: "Pension / Annuity u/s 12(2)(f)", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },
  SALARY_PERQUISITES: { code: "1089", description: "Value of Perquisites", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },
  SALARY_ARREARS: { code: "1010", description: "Arrears of Salary", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },
  SALARY_EXPENDITURE_REIMBURSEMENT: { code: "1059", description: "Expenditure Reimbursement", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },
  SALARY_PROFITS_IN_LIEU: { code: "1099", description: "Profits in Lieu of or in Addition to Pay, Wages or Other Remuneration", portalArea: "Employment", section: "Salary", rowLevel: "Line item" },

  // Property
  PROPERTY_INCOME: { code: "2000", description: "Income / (Loss) from Property", portalArea: "Property", section: "Receipts / Deductions", rowLevel: "Summary" },
  PROPERTY_TOTAL_RECEIPTS: { code: "2029", description: "Total Receipts from Property", portalArea: "Property", section: "Receipts / Deductions", rowLevel: "Summary" },
  PROPERTY_RENT_RECEIVED: { code: "2001", description: "Rent Received or Receivable", portalArea: "Property", section: "Receipts / Deductions", rowLevel: "Line item" },
  PROPERTY_REPAIR_1_5TH: { code: "2031", description: "1/5th of Rent of Building for Repairs", portalArea: "Property", section: "Receipts / Deductions", rowLevel: "Line item" },
  PROPERTY_TOTAL_DEDUCTIONS: { code: "2099", description: "Total Deductions from Property", portalArea: "Property", section: "Receipts / Deductions", rowLevel: "Summary" },

  // Other Sources
  OTHER_SOURCES_INCOME: { code: "5000", description: "Income / (Loss) from Other Sources", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Summary" },
  OTHER_SOURCES_RECEIPTS: { code: "5029", description: "Receipts from Other Sources", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Summary" },
  OTHER_SOURCES_PROFIT_DEBT: { code: "500312", description: "Profit on Debt", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Line item" },
  OTHER_SOURCES_BEHBOOD: { code: "5003041", description: "Yield on Behbood Certificates / Pensioner's Benefit Account", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Line item" },
  OTHER_SOURCES_RENT_SUBLEASE: { code: "5005", description: "Rent from sub lease of Land or Building", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Line item" },
  OTHER_SOURCES_ANNUITY_PENSION: { code: "5007", description: "Annuity / Pension", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Line item" },
  OTHER_SOURCES_OTHER_RECEIPTS: { code: "5028", description: "Other Receipts", portalArea: "Other Sources", section: "Receipts / Deductions", rowLevel: "Line item" },

  // Capital Gains
  CGT_GAINS: { code: "4000", description: "Gains / (Loss) from Capital Assets", portalArea: "Capital Gain", section: "Capital Gains / (Loss)", rowLevel: "Summary" },
  CGT_LONG_CONSIDERATION: { code: "4006", description: "Consideration Received on Disposal of Securities held Long Term", portalArea: "Capital Gain", section: "Long Term", rowLevel: "Line item" },
  CGT_LONG_COST: { code: "4016", description: "Cost of Acquisition Long Term", portalArea: "Capital Gain", section: "Long Term", rowLevel: "Line item" },
  CGT_LONG_NET: { code: "4017", description: "Net Gain / (Loss) on Securities held long term", portalArea: "Capital Gain", section: "Long Term", rowLevel: "Line item" },
  CGT_SHORT_CONSIDERATION: { code: "4026", description: "Consideration Received on Disposal Short Term", portalArea: "Capital Gain", section: "Short Term", rowLevel: "Line item" },
  CGT_SHORT_COST: { code: "4036", description: "Cost of Acquisition Short Term", portalArea: "Capital Gain", section: "Short Term", rowLevel: "Line item" },
  CGT_SHORT_NET: { code: "4037", description: "Net Gain / (Loss) on Securities held Short Term", portalArea: "Capital Gain", section: "Short Term", rowLevel: "Line item" },

  // Foreign / Agri
  AGRI_INCOME: { code: "6100", description: "Agriculture Income", portalArea: "Foreign Sources / Agriculture", section: "Agriculture", rowLevel: "Line item" },
  FOREIGN_INCOME: { code: "6000", description: "Foreign Income", portalArea: "Foreign Sources / Agriculture", section: "Foreign Sources", rowLevel: "Summary" },
  FOREIGN_SALARY: { code: "6011", description: "Foreign Salary Income", portalArea: "Foreign Sources / Agriculture", section: "Foreign Sources", rowLevel: "Line item" },

  // Adjustable Taxes - CRITICAL
  ADJUSTABLE_TAX: { code: "640000", description: "Adjustable Tax", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Summary" },
  ADJ_SALARY_149: { code: "64020004", description: "Salary of Employees u/s 149", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_DIRECTORSHIP_149_3: { code: "64020005", description: "Directorship Fee u/s 149(3)", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  FINAL_TRANSPORT_MONETIZATION: { code: "64210051", description: "Transport Monetization for Government Servants (after deduction of drivers salary) u/c (27), Part II, 2nd Schedule", portalArea: "Tax Chargeable / Payments", section: "Final Tax", rowLevel: "Line item" },
  FINAL_PENSION_OVER_10M: { code: "64020007", description: "149-Pension exceeding Rs. 10 million", portalArea: "Tax Chargeable / Payments", section: "Final Tax", rowLevel: "Line item" },
  AVERAGE_TERMINATION_BENEFITS: { code: "64210054", description: "Employment Termination Benefits u/s 12(6)/Withdrawal from pension fund exceeding 50% of the accumulated balance u/c 23A Chargeable to Tax at Average Rate", portalArea: "Tax Chargeable / Payments", section: "Average Tax", rowLevel: "Line item" },
  AVERAGE_SALARY_ARREARS: { code: "64210056", description: "Salary Arrears u/s 12(7) Chargeable to Tax at Relevant Rate", portalArea: "Tax Chargeable / Payments", section: "Average Tax", rowLevel: "Line item" },
  ADJUSTABLE_TAX_GROUP: { code: "999909", description: "Adjustable Tax", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Summary" },
  FINAL_TAX_GROUP: { code: "999910", description: "Final Tax", portalArea: "Tax Chargeable / Payments", section: "Final Tax", rowLevel: "Summary" },
  AVERAGE_TAX_GROUP: { code: "999911", description: "Average Tax", portalArea: "Tax Chargeable / Payments", section: "Average Tax", rowLevel: "Summary" },
  ADJ_PROFIT_DEBT_BANK_151_B: { code: "64040002", description: "Profit on Debt u/s 151(1)(b) from Bank Accounts / Deposits @15%", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_PROFIT_DEBT_NSC_151_A: { code: "64040001", description: "Profit on Debt u/s 151(1)(a) from NSC / PO Deposits @15%", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_RENT_155: { code: "64080001", description: "Rent of Immoveable Property u/s 155", portalArea: "Property", section: "Tax Deductions", rowLevel: "Line item" },
  ADJ_IMPORT_148_1PCT: { code: "64010002", description: "Import u/s 148 @1%", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_CASH_WITHDRAWAL_231AB: { code: "64100101", description: "Cash withdrawal from Bank u/s 231AB", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_VEHICLE_231B: { code: "64100301", description: "Motor Vehicle u/s 231B", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_TELEPHONE_236: { code: "64150001", description: "Telephone u/s 236", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_AUCTION_236A: { code: "64150101", description: "Sale by Auction u/s 236A", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_PROPERTY_TRANSFER_236C: { code: "64150301", description: "Sale/Transfer of Immovable Property u/s 236C", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_FUNCTION_236CB: { code: "64150407", description: "Functions / Gatherings u/s 236CB", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_DISTRIBUTOR_236G: { code: "64150701", description: "Sale to Distributors u/s 236G", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_PROPERTY_PURCHASE_236K: { code: "64151101", description: "Purchase/Transfer of Immovable Property u/s 236K", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },
  ADJ_CARD_REMITTANCE_236Y: { code: "64151905", description: "Card remittance abroad u/s 236Y", portalArea: "Tax Chargeable / Payments", section: "Adjustable Tax", rowLevel: "Line item" },

  // Computations
  COMP_DEEMED_7E: { code: "923183", description: "Tax on deemed income u/s 7E @20% (Of 5% of FMV)", portalArea: "Simplified Return of Income", section: "Computations", rowLevel: "Summary" },
  COMP_SURCHARGE: { code: "923184", description: "Surcharge u/s 4AB (approx)", portalArea: "Simplified Return of Income", section: "Computations", rowLevel: "Summary" },

  // Wealth Statement
  WEALTH_AGRI_PROPERTY: { code: "7001", description: "Agricultural Property", portalArea: "116 - Wealth Statement", section: "Personal Assets / Liabilities", rowLevel: "Line item" },
  WEALTH_NON_BUSINESS_PROPERTY: { code: "7002", description: "Commercial, Industrial, Residential Property (Non-Business)", portalArea: "116 - Wealth Statement", section: "Personal Assets / Liabilities", rowLevel: "Line item" },
  WEALTH_INVESTMENT: { code: "7006", description: "Investment (Non-Business)", portalArea: "116 - Wealth Statement", section: "Personal Assets / Liabilities", rowLevel: "Line item" },
  WEALTH_MOTOR_VEHICLE: { code: "7008", description: "Motor Vehicle (Non-Business)", portalArea: "116 - Wealth Statement", section: "Personal Assets / Liabilities", rowLevel: "Line item" },
  WEALTH_CASH: { code: "7012", description: "Cash (Non-Business)", portalArea: "116 - Wealth Statement", section: "Personal Assets / Liabilities", rowLevel: "Line item" },
} as const;

export type IrisCodeKey = keyof typeof IRIS_CODES;

/**
 * Maps our internal ledger categories to IRIS system codes
 * This is the core mapping used by portalFieldMap builder
 */
export const CATEGORY_TO_IRIS_MAP: Record<string, { incomeCode: string; taxCode?: string; description: string }[]> = {
  SALARY: [
    { incomeCode: IRIS_CODES.SALARY_INCOME.code, description: "Salary main" },
    { incomeCode: IRIS_CODES.SALARY_PAY_WAGES.code, description: "Pay/Wages breakdown" },
  ],
  // ONE IRIS line (1008) carries the pension figure; the engine's exempt/taxable split
  // stays internal. The old double mapping (1008 + 5007) wrote the same pension amount
  // into two schedules, i.e. counted it twice.
  PENSION: [
    { incomeCode: IRIS_CODES.SALARY_PENSION_ANNUITY.code, description: "Pension / Annuity u/s 12(2)(f) — whole figure; IRIS derives the split" },
  ],
  PENSION_OTHER_SOURCES: [
    { incomeCode: IRIS_CODES.OTHER_SOURCES_ANNUITY_PENSION.code, description: "Annuity/pension reported under Other Sources (explicit only — never automatic)" },
  ],
  // Verified line items only. BANK_PROFIT / PROFIT_ON_DEBT / DIVIDEND are final-tax
  // routes: their AMOUNT belongs in Other Sources → 'Subject to Final Tax' (a column
  // with no live capture yet) and their TAX arrives through the 151(a)/(b) taxCredit.
  // Pointing the amount at 500312 + a normal-tax column under-stated the final tax.
  RENT: [
    { incomeCode: IRIS_CODES.PROPERTY_RENT_RECEIVED.code, taxCode: IRIS_CODES.ADJ_RENT_155.code, description: "Rent" },
  ],
  RENTAL: [
    { incomeCode: IRIS_CODES.PROPERTY_RENT_RECEIVED.code, taxCode: IRIS_CODES.ADJ_RENT_155.code, description: "Rental" },
  ],
  PROPERTY_RENT: [
    { incomeCode: IRIS_CODES.PROPERTY_RENT_RECEIVED.code, taxCode: IRIS_CODES.ADJ_RENT_155.code, description: "Property Rent" },
  ],
  // Intentionally unmapped — reported in `portalFieldMap.mappingGaps` instead of
  // being guessed onto a code that does not exist on this taxpayer's return:
  //   DIVIDEND, BUSINESS, SERVICES, OTHER_INCOME  (5028 "Other Receipts" is not a
  //     substitute for an unknown source; it produced 3 × row_not_found live)
  //   CAPITAL_GAIN / CAPITAL_GAINS (4000 is a Summary row — IRIS computes it)
  //   FOREIGN (6000 is a Summary row), AGRICULTURE (sheet never captured)
  //   BANK_PROFIT / PROFIT_ON_DEBT (final-tax placement above)
  // Advance tax categories - from our WHT Rate Card
  ADVANCE_TAX_236C: [
    { incomeCode: IRIS_CODES.ADJ_PROPERTY_TRANSFER_236C.code, description: "Property Transfer 236C" },
  ],
  ADVANCE_TAX_236K: [
    { incomeCode: IRIS_CODES.ADJ_PROPERTY_PURCHASE_236K.code, description: "Property Purchase 236K" },
  ],
  PROPERTY_SALE: [
    { incomeCode: IRIS_CODES.ADJ_PROPERTY_TRANSFER_236C.code, description: "Property Sale 236C" },
  ],
  PROPERTY_PURCHASE: [
    { incomeCode: IRIS_CODES.ADJ_PROPERTY_PURCHASE_236K.code, description: "Property Purchase 236K" },
  ],
};

/**
 * Maps tax credit sections (like 149, 151, 236C, 236K) to IRIS codes
 */
export const TAX_SECTION_TO_IRIS_CODE: Record<string, string> = {
  "149": IRIS_CODES.ADJ_SALARY_149.code,
  "151": IRIS_CODES.ADJ_PROFIT_DEBT_BANK_151_B.code,
  "151(1)(b)": IRIS_CODES.ADJ_PROFIT_DEBT_BANK_151_B.code,
  "151(1)(a)": IRIS_CODES.ADJ_PROFIT_DEBT_NSC_151_A.code,
  "155": IRIS_CODES.ADJ_RENT_155.code,
  "148": IRIS_CODES.ADJ_IMPORT_148_1PCT.code,
  "231AB": IRIS_CODES.ADJ_CASH_WITHDRAWAL_231AB.code,
  "231B": IRIS_CODES.ADJ_VEHICLE_231B.code,
  "236": IRIS_CODES.ADJ_TELEPHONE_236.code,
  "236A": IRIS_CODES.ADJ_AUCTION_236A.code,
  "236C": IRIS_CODES.ADJ_PROPERTY_TRANSFER_236C.code,
  "236CB": IRIS_CODES.ADJ_FUNCTION_236CB.code,
  "236G": IRIS_CODES.ADJ_DISTRIBUTOR_236G.code,
  "236K": IRIS_CODES.ADJ_PROPERTY_PURCHASE_236K.code,
  "236Y": IRIS_CODES.ADJ_CARD_REMITTANCE_236Y.code,
};
