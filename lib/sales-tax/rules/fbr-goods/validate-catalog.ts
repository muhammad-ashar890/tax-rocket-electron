/**
 * Checks the rules catalog before it is trusted.
 *
 * Returns a list of problems; an empty list means the catalog is sound.
 * Same idea as lib/tax/rules/ty2026/validate-catalog.ts.
 */

import { isValidIso } from "../../dates";
import {
  REQUIRED_RULE_IDS,
  SUPPORTED_SALE_TYPES,
  type SalesTaxRule,
} from "./catalog";
import type { TemplateReference } from "./reference";

export function validateCatalog(
  rules: SalesTaxRule[],
  sales: TemplateReference,
  purchase: TemplateReference,
): string[] {
  const problems: string[] = [];

  rules.forEach((rule, index) => {
    const label = rule.id || `row ${index}`;
    if (!rule.id) problems.push(`Row ${index} has no id.`);
    if (!rule.title) problems.push(`${label}: missing title.`);
    if (!rule.section) problems.push(`${label}: missing section.`);
    if (!rule.source) problems.push(`${label}: missing source.`);
    if (!isValidIso(rule.effectiveFrom)) {
      problems.push(`${label}: effectiveFrom is not a real date.`);
    }
    if (rule.effectiveTo !== null && !isValidIso(rule.effectiveTo)) {
      problems.push(`${label}: effectiveTo is not a real date.`);
    }
    if (
      isValidIso(rule.effectiveFrom) &&
      rule.effectiveTo !== null &&
      isValidIso(rule.effectiveTo) &&
      rule.effectiveTo < rule.effectiveFrom
    ) {
      problems.push(`${label}: effectiveTo is before effectiveFrom.`);
    }
    if (!isValidIso(rule.verifiedOn)) {
      problems.push(`${label}: verifiedOn is not a real date.`);
    }
    if (typeof rule.value === "number" && !Number.isFinite(rule.value)) {
      problems.push(`${label}: value is not a finite number.`);
    }
    if (
      (rule.unit === "fraction" || rule.unit === "percent" ||
        rule.unit === "rupees" || rule.unit === "days" ||
        rule.unit === "day_of_month") &&
      typeof rule.value !== "number"
    ) {
      problems.push(`${label}: unit ${rule.unit} needs a numeric value.`);
    }
    if (rule.unit === "flag" && typeof rule.value !== "boolean") {
      problems.push(`${label}: a flag needs a true or false value.`);
    }
    if (typeof rule.value === "number") {
      if (rule.unit === "fraction" && (rule.value < 0 || rule.value > 1)) {
        problems.push(`${label}: a fraction must be between 0 and 1.`);
      }
      if (rule.unit === "percent" && (rule.value < 0 || rule.value > 100)) {
        problems.push(`${label}: a percent must be between 0 and 100.`);
      }
      if (rule.unit === "day_of_month" && (rule.value < 1 || rule.value > 28)) {
        problems.push(`${label}: a due day must be between 1 and 28 so every month has it.`);
      }
      if (rule.value < 0) problems.push(`${label}: value is negative.`);
    }
  });

  // No two rows of the same rule may cover the same day.
  const byId = new Map<string, SalesTaxRule[]>();
  for (const rule of rules) {
    byId.set(rule.id, [...(byId.get(rule.id) || []), rule]);
  }
  byId.forEach((rows, id) => {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        const aEnd = a.effectiveTo === null ? "9999-12-31" : a.effectiveTo;
        const bEnd = b.effectiveTo === null ? "9999-12-31" : b.effectiveTo;
        if (a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd) {
          problems.push(`${id}: two rows cover the same days.`);
        }
      }
    }
  });

  for (const id of REQUIRED_RULE_IDS) {
    if (!byId.has(id)) problems.push(`Required rule ${id} is missing.`);
  }

  // The supported sale types must exist in the official lists, and the
  // standard rate must be a rate the official list offers.
  for (const name of SUPPORTED_SALE_TYPES) {
    if (!sales.saleTypes.includes(name)) {
      problems.push(`Sale type "${name}" is not in the sales template list.`);
    }
    if (!purchase.saleTypes.includes(name)) {
      problems.push(`Sale type "${name}" is not in the purchase template list.`);
    }
  }
  const standard = rules.find((rule) => rule.id === "fbr.rate.standard");
  if (standard && !sales.rates.includes(standard.value as number)) {
    problems.push("The standard rate is not in the official sales rate list.");
  }
  if (standard && !purchase.rates.includes(standard.value as number)) {
    problems.push("The standard rate is not in the official purchase rate list.");
  }
  if (!sales.rates.includes("Exempt")) {
    problems.push('The official sales rate list no longer contains "Exempt".');
  }

  return problems;
}
