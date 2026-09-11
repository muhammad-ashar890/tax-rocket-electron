/**
 * FBR Agent Config - Merged from old tax-rocket-old + new IRIS codes
 *
 * This file combines:
 * - Old: Selector bundle for IRIS 2.0 (Angular) and Classic (PrimeFaces) DOM automation
 * - New: IRIS field codes from IRIS_System_Field_Codes_Extracted.csv (536 codes)
 *
 * Used by Electron agent to fill IRIS fields
 */

import {
  IRIS_CODES,
  CATEGORY_TO_IRIS_MAP,
  TAX_SECTION_TO_IRIS_CODE,
} from "./iris-field-codes";

// Re-export IRIS codes for agent
export { IRIS_CODES, CATEGORY_TO_IRIS_MAP, TAX_SECTION_TO_IRIS_CODE };

// ─── IRIS Portal Type ───────────────────────────────────

export type IrisPortalType = "iris2" | "irisv1" | "both";

export type IrisRouteFamily =
  | "simplified_salary_114i"
  | "normal_individual_114"
  | "normal_individual_114_revised"
  | "classic_individual_114"
  | "wealth_statement"
  | "pre_step_application";

export function getPortalTypeForRouteFamily(
  routeFamily: IrisRouteFamily,
): IrisPortalType {
  switch (routeFamily) {
    case "classic_individual_114":
      return "irisv1";
    case "simplified_salary_114i":
    case "normal_individual_114":
    case "normal_individual_114_revised":
      return "iris2";
    case "wealth_statement":
    case "pre_step_application":
      return "both";
    default:
      return "iris2";
  }
}

export function isClassicPortalRoute(routeFamily: IrisRouteFamily): boolean {
  return getPortalTypeForRouteFamily(routeFamily) === "irisv1";
}

// ─── Desktop Auth Config ───────────────────────────────────

const REAL_FBR_ROOT = "https://iris.fbr.gov.pk/";

function isOfficialFbrUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "iris.fbr.gov.pk";
  } catch {
    return false;
  }
}

export type FbrDesktopAuthConfig = {
  loginUrl: string;
  readySelector: string;
  readyRejectSelector: string | null;
  readyUrlPattern: string | null;
  useMockIris: boolean;
};

export function getFbrDesktopAuthConfig(): FbrDesktopAuthConfig {
  // The desktop agent is production-facing: it may connect only to the real
  // FBR portal. Keep the compatibility boolean in the handoff shape so older
  // agents fail closed, but never derive it from an environment variable or a
  // URL supplied by a stale job.
  const configuredLoginUrl = process.env.FBR_IRIS_LOGIN_URL?.trim() || "";
  const loginUrl = isOfficialFbrUrl(configuredLoginUrl)
    ? configuredLoginUrl
    : REAL_FBR_ROOT;
  return {
    loginUrl,
    // SEMANTICS: "a logged-in FBR page exists", NOT "the return is open".
    // `#homeLink` is present on the dashboard and on every return page, so it
    // confirms the session only. Return readiness is proven separately by the
    // worker's return-workspace probes.
    readySelector: process.env.FBR_IRIS_READY_SELECTOR?.trim() || "#homeLink",
    readyRejectSelector:
      process.env.FBR_IRIS_READY_REJECT_SELECTOR?.trim() || null,
    readyUrlPattern:
      process.env.FBR_IRIS_READY_URL_PATTERN?.trim() || "iris.fbr.gov.pk",
    useMockIris: false,
  };
}

// ─── Route Selector Config ───────────────────────────────────

export type FbrRouteSelectorConfig = {
  topMenuSelector: string;
  leftCategorySelector: string;
  formSelector: string;
  formReadySelector: string;
  periodSelector: string | null;
  nameSelector: string | null;
  generatePsidSelector: string | null;
  psidDisplaySelector: string | null;
  psidDownloadSelector: string | null;
  cprDisplaySelector: string | null;
  paidAmountSelector: string | null;
  balancePayableSelector: string | null;
  refundBannerSelector: string | null;
  submitButtonSelector: string | null;
  completionConfirmSelector: string | null;
};

export type FbrSelectorBundleSummary = {
  bundleId: string;
  bundleVersion: number;
  source: "default_code" | "user_settings" | "global_db";
  updatedAt: string;
  notes: string | null;
  hash: string;
};

export type FbrPortalAutomationConfig = {
  livePilot: {
    mode: "navigation_inspection_only" | "supervised_live_filing";
    automaticFilingEnabled: boolean;
  };
  portalHostAllowlist: string[];
  readiness: {
    loginUrl: string;
    readySelector: string;
    readyRejectSelector: string | null;
    readyUrlPattern: string | null;
  };
  dryRun: {
    entryUrl: string;
    reviewGateSelector: string;
    finalSubmitSelector: string;
    completedTasksSelector: string | null;
    pauseReason: string;
  };
  assistedFiling: {
    readinessUrl: string;
    passwordResetUrl: string;
    otpCaptchaUrl: string;
    paymentUrl: string;
    finalReviewUrl: string;
    completedTasksUrl: string;
  };
  classicAssistedFiling: {
    finalReviewUrl: string;
    pinEntryUrl: string;
    completedTasksUrl: string;
  };
  routeSelector: FbrRouteSelectorConfig | null;
  selectorBundle: FbrSelectorBundleSummary;
  useMockIris: boolean;
};

// ─── Default Selector Bundle (from old repo v8-default-2026-05) ───

// Real IRIS 2.0 (iris.fbr.gov.pk) renders generated ids/classes, but the
// visible labels are stable. Each selector chain ends in "text:..." fallbacks
// that the desktop agent resolves by matching visible text on the page.
const COMMON_RETURN_SELECTORS: Omit<FbrRouteSelectorConfig, "formSelector"> = {
  topMenuSelector:
    "#top-menu-income-tax-return, [data-iris-top-menu='income_tax_return'], a[href*='IncomeTaxReturn'], a[href*='income-tax-return'], text:Declaration",
  leftCategorySelector:
    "#left-category-income-tax-return, [data-iris-left-category='income_tax_return'], a[href*='IncomeTaxReturn'], text:Income Tax Return",
  formReadySelector:
    "#iris-return-form-ready, form[data-iris-form-ready='true'], #return-tax-form",
  periodSelector:
    "#return-period, select[name='taxYear'], select[data-iris-field='tax_year'], input[name='taxYear']",
  nameSelector:
    "#taxpayer-name, input[name='taxpayerName'], input[data-iris-field='taxpayer_name']",
  generatePsidSelector: "#generate-psid, [data-action='generate-psid']",
  psidDisplaySelector: "#psid-number, [data-payment='psid-number']",
  psidDownloadSelector: "#download-psid, [data-action='download-psid']",
  cprDisplaySelector:
    "#cpr-reference, #mock-cpr-reference, [data-payment='cpr-reference']",
  paidAmountSelector: "#paid-amount, [data-payment='paid-amount']",
  balancePayableSelector: "#balance-payable, [data-payment='balance-payable']",
  refundBannerSelector: "#refund-banner, [data-payment='refund-banner']",
  submitButtonSelector:
    "#final-submit, button[data-action='submit-return'], button[type='submit']",
  completionConfirmSelector:
    "#completed-tasks-proof, [data-proof='completed-tasks'], [id*='completed-tasks']",
};

export const DEFAULT_SELECTOR_BUNDLE = {
  id: "v8-default-2026-05-merged-with-iris-codes",
  version: 2,
  updatedAt: "2026-05-13T00:00:00.000Z",
  notes:
    "Merged bundle: old v8 selectors + new IRIS field codes (1000, 2001, 500312, 64150301 etc) from IRIS_System_Field_Codes_Extracted.csv",
  routeSelectors: {
    simplified_salary_114i: {
      ...COMMON_RETURN_SELECTORS,
      formSelector:
        "#form-114i, [data-iris-form='simplified_salary_114i'], [href*='114i'], [id*='114i'], text:114(1), text:Income Tax Return",
    },
    normal_individual_114: {
      ...COMMON_RETURN_SELECTORS,
      formSelector:
        "#form-114, [data-iris-form='normal_individual_114'], [href*='normal-individual-114'], [id='form-114-original'], text:114(1), text:Return of Income filed voluntarily",
    },
    normal_individual_114_revised: {
      ...COMMON_RETURN_SELECTORS,
      formSelector:
        "#form-114-revised, [data-iris-form='normal_individual_114_revised'], [href*='114'][href*='revised'], [id*='revised-114'], text:Revised, text:114(1)",
    },
    wealth_statement: {
      ...COMMON_RETURN_SELECTORS,
      topMenuSelector:
        "#top-menu-wealth-statement, [data-iris-top-menu='wealth_statement'], a[href*='WealthStatement']",
      leftCategorySelector:
        "#left-category-wealth-statement, [data-iris-left-category='wealth_statement'], a[href*='WealthStatement']",
      formSelector:
        "#form-wealth-statement, [data-iris-form='wealth_statement'], [href*='wealth-statement']",
    },
    pre_step_application: {
      ...COMMON_RETURN_SELECTORS,
      topMenuSelector:
        "#top-menu-application, [data-iris-top-menu='application'], a[href*='Application']",
      leftCategorySelector:
        "#left-category-application, [data-iris-left-category='application'], a[href*='Application']",
      formSelector:
        "#form-114i-election, [data-iris-form='pre_step_application'], [href*='114i'][href*='election']",
    },
    classic_individual_114: {
      topMenuSelector:
        "#correspondenceTabs\\:returnAmountForm\\:menuPanel, .return-data-left-menu .ui-panelmenu",
      leftCategorySelector:
        "#correspondenceTabs\\:returnAmountForm\\:j_idt425, .ui-panelmenu",
      formSelector:
        "#correspondenceTabs\\:returnAmountForm\\:data, form[id*='businessFormReturn'], form[id*='returnAmountForm']",
      formReadySelector:
        "#correspondenceTabs\\:returnAmountForm\\:data table.ui-datatable, .ui-datatable-data",
      periodSelector: null,
      nameSelector: null,
      generatePsidSelector: null,
      psidDisplaySelector: null,
      psidDownloadSelector: null,
      cprDisplaySelector: null,
      paidAmountSelector: null,
      balancePayableSelector: null,
      refundBannerSelector: null,
      submitButtonSelector:
        "#correspondence\\:btnSave, button[id*='btnSave'], button[id*='btnSubmit']",
      completionConfirmSelector:
        "#correspondence\\:btnSubmit, button[id*='btnSubmit']",
    },
  } as Record<IrisRouteFamily, FbrRouteSelectorConfig>,
};

// Only explicit, approved packet route metadata can select a return family.
// `filerType` describes the app profile, not a legal IRIS form. Do not infer it.
export function resolveIrisRouteFamily(value: unknown): IrisRouteFamily | null {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors,
      value,
    )
    ? (value as IrisRouteFamily)
    : null;
}

// ─── Automation Config Builder ───────────────────────────────────

function splitHosts(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The deployment's own consent for letting the agent type into IRIS.
 *
 * The operator has `TAXROCKET_REAL_AUTOFILL` in the agent's shell; this is the
 * second, independent half — a value the SHIPPED app decides, so a stale copy of
 * the desktop agent, or an operator who exported the env var in a hurry, cannot on
 * its own write into a government return. Unset, empty or unrecognised means off:
 * the only accepted spellings are `true`, `1`, `on`, `yes` (same set the agent's
 * own parser accepts, so the two switches cannot disagree about what "on" means).
 *
 * It lives in the server environment because the server builds the job context:
 * there is no DB table for it, which is deliberate — a row that silently enables
 * writes would outlive the deployment that set it.
 */
export const LIVE_FILING_ENV_VAR = "TAXROCKET_ALLOW_LIVE_FILING";

const LIVE_FILING_ON_VALUES = new Set(["true", "1", "on", "yes"]);

export function isLiveFilingEnabledByDeployment(): boolean {
  const raw = String(process.env[LIVE_FILING_ENV_VAR] ?? "")
    .trim()
    .toLowerCase();
  return LIVE_FILING_ON_VALUES.has(raw);
}

export async function getFbrPortalAutomationConfig(input?: {
  routeFamily?: IrisRouteFamily | null;
}): Promise<FbrPortalAutomationConfig> {
  const desktop = getFbrDesktopAuthConfig();
  const allowlist = splitHosts(process.env.FBR_IRIS_HOST_ALLOWLIST);

  if (allowlist.length === 0 && !desktop.useMockIris) {
    allowlist.push("iris.fbr.gov.pk");
  }

  // Real IRIS is a SPA with no stable static routes for the supervised
  // checkpoints (password reset, OTP/PIN, payment, final review). When the
  // pilot runs against the real portal, every checkpoint stays on the IRIS
  // root (the post-login dashboard) instead of local test pages.
  const realIrisRoot = REAL_FBR_ROOT;
  const stageUrl = (envValue?: string) => {
    const url = envValue?.trim() || realIrisRoot;
    return isOfficialFbrUrl(url) ? url : realIrisRoot;
  };

  const routeSelector =
    input?.routeFamily &&
    DEFAULT_SELECTOR_BUNDLE.routeSelectors[input.routeFamily]
      ? DEFAULT_SELECTOR_BUNDLE.routeSelectors[input.routeFamily]
      : null;

  const liveFilingEnabled = isLiveFilingEnabledByDeployment();

  return {
    // `automaticFilingEnabled` is read by the agent (main.js:resolveAutofillMode):
    // an explicit `false` downgrades TAXROCKET_REAL_AUTOFILL=live to a dry run, so
    // this is a deployment-level kill switch rather than a decorative flag. It is
    // only honoured when present as a boolean — `true` does NOT enable writes by
    // itself, the operator's env var still has to opt in. Both halves are required,
    // and `mode` carries which half is which so a log line says it out loud.
    livePilot: {
      mode: liveFilingEnabled ? "supervised_live_filing" : "navigation_inspection_only",
      automaticFilingEnabled: liveFilingEnabled,
    },
    portalHostAllowlist: allowlist,
    readiness: {
      loginUrl: desktop.loginUrl,
      readySelector: desktop.readySelector,
      readyRejectSelector: desktop.readyRejectSelector,
      readyUrlPattern: desktop.readyUrlPattern,
    },
    dryRun: {
      entryUrl: stageUrl(process.env.FBR_IRIS_DRY_RUN_URL),
      reviewGateSelector:
        process.env.FBR_IRIS_REVIEW_GATE_SELECTOR?.trim() ||
        "#dry-run-review-gate",
      finalSubmitSelector:
        process.env.FBR_IRIS_FINAL_SUBMIT_SELECTOR?.trim() || "#final-submit",
      completedTasksSelector:
        process.env.FBR_IRIS_COMPLETED_TASKS_SELECTOR?.trim() ||
        "#completed-tasks-proof",
      pauseReason:
        process.env.FBR_IRIS_DRY_RUN_PAUSE_REASON?.trim() ||
        "Dry-run reached the final review gate. Final submit stays user controlled.",
    },
    assistedFiling: {
      readinessUrl: stageUrl(process.env.FBR_IRIS_ASSISTED_READINESS_URL),
      passwordResetUrl: stageUrl(process.env.FBR_IRIS_PASSWORD_RESET_URL),
      otpCaptchaUrl: stageUrl(process.env.FBR_IRIS_OTP_CAPTCHA_URL),
      paymentUrl: stageUrl(process.env.FBR_IRIS_PAYMENT_URL),
      finalReviewUrl: stageUrl(process.env.FBR_IRIS_FINAL_REVIEW_URL),
      completedTasksUrl: stageUrl(process.env.FBR_IRIS_COMPLETED_TASKS_URL),
    },
    classicAssistedFiling: {
      finalReviewUrl: stageUrl(process.env.FBR_IRIS_CLASSIC_FINAL_REVIEW_URL),
      pinEntryUrl: stageUrl(process.env.FBR_IRIS_CLASSIC_PIN_URL),
      completedTasksUrl: stageUrl(process.env.FBR_IRIS_CLASSIC_COMPLETED_TASKS_URL),
    },
    routeSelector,
    selectorBundle: {
      bundleId: DEFAULT_SELECTOR_BUNDLE.id,
      bundleVersion: DEFAULT_SELECTOR_BUNDLE.version,
      source: "default_code",
      updatedAt: DEFAULT_SELECTOR_BUNDLE.updatedAt,
      notes: DEFAULT_SELECTOR_BUNDLE.notes,
      hash: "merged-v2",
    },
    useMockIris: desktop.useMockIris,
  };
}

export async function getActiveFbrSelectorBundle() {
  return {
    activeBundle: {
      bundleId: DEFAULT_SELECTOR_BUNDLE.id,
      bundleVersion: DEFAULT_SELECTOR_BUNDLE.version,
      source: "default_code" as const,
      updatedAt: DEFAULT_SELECTOR_BUNDLE.updatedAt,
      notes: DEFAULT_SELECTOR_BUNDLE.notes,
      hash: "merged-v2",
    },
    selectorsByRouteFamily: DEFAULT_SELECTOR_BUNDLE.routeSelectors,
  };
}

// ─── PrimeFaces Helpers (from old repo) ───────────────────────────────────

export function buildPrimeFacesMenuClick(menuId: string): string {
  const safeMenuId = menuId.replace(/[^a-zA-Z0-9_-]/g, "");
  return [
    `PrimeFaces.ab({`,
    `  s:"correspondenceTabs:returnAmountForm:${safeMenuId}",`,
    `  u:"correspondenceTabs:returnAmountForm:dropDown correspondenceTabs:returnAmountForm:showCalculateButtonPnl correspondenceTabs:returnAmountForm:data correspondenceTabs:returnAmountForm:menuPanel",`,
    `  ps:true,`,
    `  f:"correspondenceTabs:returnAmountForm"`,
    `});`,
  ].join("");
}

export function buildJsfDataTableCellSelector(
  rowIndex: number,
  column: "total" | "exempt" | "taxable",
): string {
  return `#correspondenceTabs\\:returnAmountForm\\:data\\:${rowIndex}\\:${column}`;
}

export function buildPrimeFacesDialogOpen(widgetVar: string): string {
  const safeVar = widgetVar.replace(/[^a-zA-Z0-9_]/g, "");
  return `PF('${safeVar}').show();`;
}

export function buildPrimeFacesToolbarAction(
  action: "save" | "submit" | "cancel" | "edit",
): string {
  const sourceMap: Record<string, string> = {
    edit: "correspondence:edit",
    save: "correspondence:btnSave",
    submit: "correspondence:btnSubmit",
    cancel: "correspondence:btnCancle",
  };
  const source =
    sourceMap[action] ??
    `correspondence:btn${action.charAt(0).toUpperCase() + action.slice(1)}`;
  return `PrimeFaces.ab({s:"${source}"});`;
}

// ─── IRIS Field Mapping Helpers ───────────────────────────────────

/**
 * Get IRIS system code for a given category
 * Example: SALARY -> 1000, RENT -> 2001, BANK_PROFIT -> 500312, 236C -> 64150301
 */
export function getIrisCodeForCategory(category: string): string | null {
  const normalized = category.toUpperCase().trim();
  const mapping = CATEGORY_TO_IRIS_MAP[normalized];
  if (mapping && mapping.length > 0) {
    return mapping[0].incomeCode;
  }
  return null;
}

/**
 * Get adjustable tax code for a section
 * Example: 149 -> 64020004, 236C -> 64150301, 236K -> 64151101
 */
export function getIrisCodeForTaxSection(section: string): string | null {
  return (
    TAX_SECTION_TO_IRIS_CODE[section] ||
    TAX_SECTION_TO_IRIS_CODE[section.toUpperCase()] ||
    null
  );
}

/**
 * Build selector for IRIS field by system code
 * Used by Electron agent to find input in IRIS DOM
 */
export function buildIrisFieldSelectorByCode(systemCode: string): string {
  return `[data-system-code="${systemCode}"] input, [data-iris-code="${systemCode}"] input, input[name*="${systemCode}"], #field-${systemCode} input`;
}

/**
 * Combined config for agent: selectors + field codes
 */
export function getCombinedAgentConfig() {
  return {
    selectors: DEFAULT_SELECTOR_BUNDLE,
    irisCodes: IRIS_CODES,
    categoryMap: CATEGORY_TO_IRIS_MAP,
    taxSectionMap: TAX_SECTION_TO_IRIS_CODE,
  };
}
