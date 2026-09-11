/**
 * Authoritative IRIS capture contract for Property coverage.
 *
 * Source captures:
 *   uploads/Property Receipts-Deductions sidebar tab.html
 *   uploads/Property - Tax Deductions.html
 *
 * This is an audit contract, not a calculation rule. The receipts capture is
 * the empty/no-selected-property state: 2001 and 2031 render disabled there,
 * so neither row may become writable until a later post-+ Property capture
 * proves that state.
 */

export const PROPERTY_RECEIPTS_COLUMNS = [
  "Total Amount",
  "Subject to Exemption",
  "Subject to Normal Tax",
] as const;

export const PROPERTY_RECEIPTS_ROWS = {
  "2000": {
    label: "Income / (Loss) from Property",
    writableInputIndexes: [],
    state: "computed",
  },
  "2029": {
    label: "Total Receipts from Property",
    writableInputIndexes: [],
    state: "computed",
  },
  "2001": {
    label: "Rent Received or Receivable",
    writableInputIndexes: [],
    state: "conditional-disabled-no-property-selected",
  },
  "2002": {
    label: "1/10th of amount not adjustable against Rent",
    writableInputIndexes: [0],
    state: "writable",
  },
  "2003": {
    label: "Forfeited Deposit under a Contract for Sale of Property",
    writableInputIndexes: [0],
    state: "writable",
  },
  "2004": {
    label: "Recovery of Unpaid Irrecoverable Rent allowed as deduction",
    writableInputIndexes: [0, 1],
    state: "writable",
  },
  "2005": {
    label: "Unpaid Liabilities exceeding three Years",
    writableInputIndexes: [0, 1],
    state: "writable",
  },
  "2099": {
    label: "Total Deductions from Property",
    writableInputIndexes: [],
    state: "computed",
  },
  "2031": {
    label: "1/5th of Rent of Building for Repairs",
    writableInputIndexes: [],
    state: "computed-or-conditional-disabled",
  },
} as const;

export const PROPERTY_TAX_DEDUCTION_COLUMNS = [
  "Taxable Amount",
  "Tax Deducted",
] as const;

export const PROPERTY_TAX_DEDUCTION_ROWS = {
  "999912": {
    label: "Adjustable Tax",
    writableInputIndexes: [],
    state: "computed",
  },
  "64080001": {
    label: "Rent of Immoveable Property u/s 155",
    writableInputIndexes: [0, 1],
    state: "writable",
  },
} as const;

export const PROPERTY_RECEIPTS_SELECTION_CONTRACT = {
  addPropertyControl: {
    text: "+ Property",
    type: "button",
    classToken: "btn-section-add",
    title: "Select Property",
  },
  addDeductionControl: {
    text: "+ Deduction",
    type: "button",
    classToken: "btn-section-add",
    title: "Add Section",
  },
  navigationControls: ["NEXT", "BACK"],
  requiredBeforeRentMapping: true,
  note:
    "The supplied capture has no selected property. Do not map rent or repairs as writable from it.",
} as const;

export const PROPERTY_SELECTION_POPUP_CONTRACT = {
  capture: "uploads/seelect property popup.html",
  dialog: {
    tag: "mat-dialog-container",
    role: "dialog",
    ariaModal: "true",
    component: "app-select-property",
    title: "Select Property",
  },
  searchInput: {
    type: "text",
    placeholder: "Search Property",
    idObserved: "mat-input-11",
    ariaInvalid: "false",
    ariaRequired: "false",
  },
  emptyState: {
    classToken: "empty-state",
    title: "Can't find properties?",
    message:
      "Please add through Wealth Statement/ balance sheet/ Immoveable properties (For Non-Resident only).",
    propertyRecordsRendered: false,
  },
  preExistingSectionId: "pre-existing-section",
  selectionActionTaken: false,
  note:
    "The popup contains no property record to select. Do not create a placeholder property or infer residency from its guidance text.",
} as const;

export const PROPERTY_CERTIFICATE_AUDIT = {
  fileInputsInSuppliedScope: ["doc_9230", "doc_3000", "doc_3003"],
  propertySpecificCertificateControlPresent: false,
  mappingDecision: "no_certificate_control_in_captured_scope",
} as const;
