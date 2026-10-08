/**
 * Plain-language problem messages.
 *
 * Every message says what happened, why it matters and what to do. Nothing
 * shown to the user is a technical code; the code only identifies the
 * message for tests and logs.
 */

import type { ProblemSeverity, ProblemSheet, SalesTaxProblem } from "./types";

type Params = Record<string, string | number>;

interface ProblemDefinition {
  severity: ProblemSeverity;
  message: (params: Params) => string;
  action: (params: Params) => string;
}

const DEFINITIONS: Record<string, ProblemDefinition> = {
  invalid_period: {
    severity: "error",
    message: () => "The tax month is not a valid month.",
    action: () => "Pick the month and year the return is for.",
  },
  template_layout_changed: {
    severity: "error",
    message: (p) =>
      `The ${p.sheet} file does not have the columns we expect, so we cannot read it safely.`,
    action: () =>
      "Download the current invoice template from IRIS (Invoice Management) and copy your invoices into it.",
  },
  template_version_unsupported: {
    severity: "error",
    message: (p) =>
      `The ${p.sheet} template version ${p.found} is not one we have checked.`,
    action: (p) =>
      `Use the current template from IRIS (we have checked version ${p.expected}). If IRIS now offers a newer version, tell us so we can check it.`,
  },
  template_wrong_kind: {
    severity: "error",
    message: (p) =>
      `This file is a ${p.found} template but a ${p.expected} template was expected.`,
    action: () =>
      "Upload the sales file as sales and the purchase file as purchases.",
  },
  template_registration_mismatch: {
    severity: "error",
    message: (p) =>
      `The registration number in the ${p.sheet} file (${p.found}) is not the client's (${p.expected}).`,
    action: () =>
      "Open the right client, or use the template that was prepared for this client.",
  },
  template_period_mismatch: {
    severity: "error",
    message: (p) =>
      `The ${p.sheet} file is for ${p.found} but the return is for ${p.expected}.`,
    action: () => "Choose the file for the same month as the return.",
  },
  template_reports_invalid_rows: {
    severity: "warning",
    message: (p) =>
      `The ${p.sheet} file says ${p.count} of its rows are invalid.`,
    action: () =>
      "Open the file, fix the rows it marks invalid and upload it again.",
  },
  row_missing_field: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: "${p.field}" is empty. IRIS needs it, so this invoice would be rejected.`,
    action: (p) => `Fill in "${p.field}" on row ${p.row}.`,
  },
  row_unreadable_cell: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: "${p.field}" is not a valid ${p.field === "Date" ? "date" : "amount"}, so we cannot read this row.`,
    action: (p) =>
      `Type a ${p.field === "Date" ? "real date" : "plain number"} in "${p.field}" on row ${p.row}.`,
  },
  row_negative_amount: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: "${p.field}" is negative. Amounts must be zero or more; the document type (credit note or debit note) decides the direction.`,
    action: (p) =>
      `Enter the positive amount on row ${p.row} and set the document type correctly.`,
  },
  row_value_not_in_list: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: "${p.value}" is not one of the choices IRIS offers for "${p.field}".`,
    action: (p) =>
      `Pick a value for "${p.field}" from the template's drop-down list on row ${p.row}.`,
  },
  row_date_outside_period: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: the date ${p.value} is outside the return month, so IRIS will not count it in this return.`,
    action: (p) =>
      `Correct the date on row ${p.row}, or move the invoice to the right month's file.`,
  },
  row_duplicate: {
    severity: "error",
    message: (p) =>
      `Row ${p.row} repeats row ${p.firstRow} exactly. Counting it twice would overstate the tax.`,
    action: (p) => `Delete row ${p.row} if it is a duplicate.`,
  },
  row_invoice_number_reused: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: document number ${p.value} is already used on row ${p.firstRow} for a different party or date.`,
    action: (p) =>
      `Give each invoice its own number, or correct the party or date on row ${p.row}.`,
  },
  row_party_id_missing: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: the ${p.party} is marked Registered but has no registration number.`,
    action: (p) =>
      `Enter the ${p.party}'s registration number (STRN, NTN or CNIC) on row ${p.row}.`,
  },
  row_party_id_unusual: {
    severity: "warning",
    message: (p) =>
      `Row ${p.row}: "${p.value}" does not look like an NTN, CNIC or sales tax registration number.`,
    action: (p) => `Check the number on row ${p.row}.`,
  },
  row_unregistered_buyer_without_id: {
    severity: "warning",
    message: (p) =>
      `Row ${p.row}: the buyer is unregistered and no CNIC or NTN is given. IRIS may treat related input tax as inadmissible (return line 6a).`,
    action: (p) =>
      `Add the buyer's CNIC or NTN on row ${p.row} where you have it.`,
  },
  row_tax_mismatch: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: the sales tax is ${p.stated} but the value and rate give ${p.expected}. IRIS checks this and would mark the row invalid.`,
    action: (p) => `Correct the value, the rate or the tax on row ${p.row}.`,
  },
  row_rate_not_expected: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: the rate ${p.rate} does not fit the sale type "${p.saleType}". ${p.detail}`,
    action: (p) => `Correct the sale type or the rate on row ${p.row}.`,
  },
  row_reference_missing: {
    severity: "warning",
    message: (p) =>
      `Row ${p.row}: this is a ${p.kind} supply but no SRO or schedule reference is given. IRIS normally asks for it.`,
    action: (p) =>
      `Add the SRO or schedule number and item number on row ${p.row}.`,
  },
  row_retail_price_missing: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: Third Schedule goods are taxed on the retail price, but the retail price column is empty.`,
    action: (p) => `Enter the retail price on row ${p.row}.`,
  },
  row_note_reference_missing: {
    severity: "error",
    message: (p) =>
      `Row ${p.row}: a ${p.noteKind} must name the original invoice and give a reason.`,
    action: (p) =>
      `Fill in the invoice reference number and the reason on row ${p.row}.`,
  },
  row_further_tax_missing: {
    severity: "warning",
    message: (p) =>
      `Row ${p.row}: the buyer is not registered but no further tax is charged. Further tax of ${p.rate} normally applies unless a notification exempts this supply.`,
    action: (p) => `Check whether further tax should be added on row ${p.row}.`,
  },
  row_further_tax_mismatch: {
    severity: "warning",
    message: (p) =>
      `Row ${p.row}: further tax is ${p.stated} but ${p.rate} of the value is ${p.expected}.`,
    action: (p) => `Check the further tax on row ${p.row}.`,
  },
  row_unsupported_sale_type: {
    severity: "refuse",
    message: (p) =>
      `Row ${p.row}: the sale type "${p.value}" is not supported yet. We do not guess, so this month cannot be estimated.`,
    action: () =>
      "Prepare this month directly in IRIS, or remove the rows of this type and handle them separately.",
  },
  row_withholding_document: {
    severity: "refuse",
    message: (p) =>
      `Row ${p.row}: withholding documents (STWH) are not supported yet, so this month cannot be estimated.`,
    action: () => "Prepare this month directly in IRIS.",
  },
  row_extra_tax: {
    severity: "refuse",
    message: (p) =>
      `Row ${p.row}: extra tax is not supported yet, so this month cannot be estimated.`,
    action: () => "Prepare this month directly in IRIS.",
  },
  row_unsupported_column: {
    severity: "refuse",
    message: (p) =>
      `Row ${p.row}: "${p.field}" is filled in. That is only used for special sectors and is not supported yet, so this month cannot be estimated.`,
    action: () => "Prepare this month directly in IRIS.",
  },
  purchase_unregistered_with_tax: {
    severity: "warning",
    message: (p) =>
      `Row ${p.row}: tax is shown on a purchase from an unregistered supplier. No input tax credit is allowed on it.`,
    action: (p) =>
      `Check row ${p.row}. If the supplier is really registered, change the supplier type.`,
  },
  purchase_supplier_status_unknown: {
    severity: "warning",
    message: () =>
      "IRIS decides whether each supplier is an active taxpayer. Input tax from a supplier who is not active can be refused, and a supplier's unpaid tax can block your return (return lines 7a to 7c).",
    action: () =>
      "Check the supplier invoices in IRIS before you rely on the credit shown here.",
  },
  import_vat_unsupported: {
    severity: "refuse",
    message: (p) =>
      `Import ${p.gdNo}: value addition tax on commercial imports is not supported yet, so this month cannot be estimated.`,
    action: () => "Prepare this month directly in IRIS.",
  },
  import_invalid_amount: {
    severity: "error",
    message: (p) => `Import ${p.gdNo}: an amount is missing or negative.`,
    action: () =>
      "Enter the taxable value and the sales tax paid as zero or positive numbers.",
  },
  export_invalid_amount: {
    severity: "error",
    message: (p) => `Export ${p.documentNo}: the value is missing or negative.`,
    action: () => "Enter the export value as a positive number.",
  },
  adjustment_invalid: {
    severity: "error",
    message: (p) => `The amount for "${p.field}" is not a valid amount.`,
    action: () => "Enter a number that is zero or more.",
  },
  cap_percent_invalid: {
    severity: "error",
    message: () =>
      "The input tax limit percentage must be a whole number from 1 to 100.",
    action: () =>
      "Enter the percentage that applies to this client (90 unless FBR has set another).",
  },
  rule_missing: {
    severity: "refuse",
    message: (p) =>
      `We have no verified rule for "${p.rule}" on this date, so this month cannot be estimated.`,
    action: () => "Prepare this month directly in IRIS.",
  },
  refund_exceeds_credit: {
    severity: "error",
    message: () =>
      "The refund claimed is more than the unadjusted credit available for refund (line 28).",
    action: () =>
      "Lower the refund claimed, or check the invoices that make up the credit.",
  },
  refund_needs_annex_h: {
    severity: "warning",
    message: () =>
      "A refund claim needs a stock statement (Annex-H) in IRIS, now or later as the rules allow. We do not prepare it.",
    action: () => "Prepare Annex-H in IRIS before you rely on the refund.",
  },
  withheld_exceeds_output: {
    severity: "warning",
    message: () =>
      "Tax withheld by your buyers is more than the output tax. Line 17 becomes negative.",
    action: () => "Check the withheld amounts on the sales rows.",
  },
  exempt_supplies_need_apportionment: {
    severity: "warning",
    message: () =>
      "Some sales are exempt. Input tax on purchases used for exempt supplies is not creditable (line 7), and we have no amount entered for it.",
    action: () =>
      "Work out the non-creditable input tax and enter it as line 7.",
  },
  no_invoices: {
    severity: "warning",
    message: () => "There are no invoices for this month.",
    action: () =>
      "If you had no business activity, file a null return in IRIS instead. Otherwise upload the invoices.",
  },
  adjustments_exceed_input: {
    severity: "error",
    message: () =>
      "The deductions on lines 6a, 7 and 7a are more than the input tax available, which would make line 8 negative.",
    action: () => "Check the amounts entered for lines 6a, 7 and 7a.",
  },
};

export function makeProblem(
  code: string,
  sheet: ProblemSheet,
  row: number | null,
  params: Params = {},
  severityOverride?: ProblemSeverity,
): SalesTaxProblem {
  const definition = DEFINITIONS[code];
  if (!definition) throw new Error(`Unknown problem code ${code}.`);
  // An explicit `sheet` parameter ("sales" or "purchases") wins, so a
  // template problem names the file it is about.
  const merged: Params = { sheet, ...params, ...(row === null ? {} : { row }) };
  return {
    code,
    severity: severityOverride || definition.severity,
    sheet,
    row,
    message: definition.message(merged),
    action: definition.action(merged),
  };
}

export const PROBLEM_CODES = Object.keys(DEFINITIONS);
