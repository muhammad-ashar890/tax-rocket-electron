import type {
  RateCardRule,
  RateCardValue,
} from "@/lib/tax/rules/rate-card-types";
import {
  TY2026_RATE_CARD_RULES,
  TY2026_RATE_CARD_SECTION_IDS,
} from "./catalog";

export const TY2026_EXPECTED_RATE_CARD_RULE_COUNT = 152;

export const TY2026_EXPECTED_SECTION_RULE_COUNTS: Readonly<Record<string, number>> = {
  "148": 10,
  "149": 7,
  "149(IA)": 3,
  "150": 7,
  "151": 6,
  "151A": 1,
  "152": 19,
  "153": 15,
  "154": 2,
  "154A": 2,
  "155": 5,
  "156": 2,
  "156A": 1,
  "231AB": 1,
  "231B": 23,
  "231C": 1,
  "233": 3,
  "234": 19,
  "235": 6,
  "236": 2,
  "236A": 2,
  "236C": 3,
  "236CA": 3,
  "236CB": 1,
  "236G": 2,
  "236H": 1,
  "236K": 3,
  "236Y": 1,
  "236Z": 1,
};

function validateRateValue(
  rule: RateCardRule,
  status: string,
  value: RateCardValue,
  errors: string[],
) {
  const prefix = `${rule.id} (${status})`;

  if (value.kind === "PERCENT" || value.kind === "MARGINAL") {
    if (!Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100) {
      errors.push(`${prefix}: percentage must be between 0 and 100`);
    }
  }

  if (value.kind === "MARGINAL") {
    if (value.baseTax < 0 || value.excessOver < 0) {
      errors.push(`${prefix}: marginal baseTax/excessOver cannot be negative`);
    }
  }

  if (value.kind === "FIXED" || value.kind === "PER_UNIT") {
    if (!Number.isFinite(value.amount) || value.amount < 0) {
      errors.push(`${prefix}: fixed/per-unit amount cannot be negative`);
    }
  }

  if (value.kind === "RANGE") {
    if (value.minimum < 0 || value.maximum < value.minimum) {
      errors.push(`${prefix}: invalid amount range`);
    }
  }

  if (value.kind === "COMPOSITE") {
    if (value.components.length === 0) {
      errors.push(`${prefix}: composite formula needs components`);
    }
    for (const component of value.components) {
      if (component.percent < 0 || component.percent > 100) {
        errors.push(`${prefix}: invalid composite percentage`);
      }
    }
  }
}

export function validateTy2026RateCardCatalog() {
  const errors: string[] = [];
  const ids = new Set<string>();
  const sections = new Set<string>();
  const pages = new Set<number>();

  if (TY2026_RATE_CARD_RULES.length !== TY2026_EXPECTED_RATE_CARD_RULE_COUNT) {
    errors.push(
      `Expected ${TY2026_EXPECTED_RATE_CARD_RULE_COUNT} catalogued rows, found ${TY2026_RATE_CARD_RULES.length}`,
    );
  }

  for (const item of TY2026_RATE_CARD_RULES) {
    if (ids.has(item.id)) errors.push(`Duplicate rule ID: ${item.id}`);
    ids.add(item.id);
    sections.add(item.section);
    pages.add(item.page);

    if (!item.id.startsWith("TY2026-")) {
      errors.push(`${item.id}: ID must start with TY2026-`);
    }
    if (item.taxYear !== 2026) {
      errors.push(`${item.id}: wrong tax year`);
    }
    if (item.page < 1 || item.page > 14) {
      errors.push(`${item.id}: page must be between 1 and 14`);
    }
    if (!item.source.trim() || !item.subcategory.trim() || !item.label.trim()) {
      errors.push(`${item.id}: source, subcategory and label are required`);
    }

    const rateEntries = Object.entries(item.rates);
    if (rateEntries.length === 0 && !item.surcharge) {
      errors.push(`${item.id}: at least one status rate or a surcharge is required`);
    }
    for (const [status, value] of rateEntries) {
      if (value) validateRateValue(item, status, value, errors);
    }

    if (item.surcharge) {
      if (item.surcharge.basis !== "CALCULATED_TAX") {
        errors.push(`${item.id}: surcharge must use CALCULATED_TAX basis`);
      }
      if (item.surcharge.percent < 0 || item.surcharge.percent > 100) {
        errors.push(`${item.id}: invalid surcharge percentage`);
      }
    }

    const amount = item.condition?.amount;
    if (amount) {
      const lower = amount.minInclusive ?? amount.minExclusive;
      const upper = amount.maxInclusive ?? amount.maxExclusive;
      if (lower !== undefined && upper !== undefined && lower > upper) {
        errors.push(`${item.id}: condition lower boundary exceeds upper boundary`);
      }
    }
  }

  for (const expectedSection of TY2026_RATE_CARD_SECTION_IDS) {
    if (!sections.has(expectedSection)) {
      errors.push(`Missing PDF section: ${expectedSection}`);
    }

    const actualSectionCount = TY2026_RATE_CARD_RULES.filter(
      (item) => item.section === expectedSection,
    ).length;
    const expectedSectionCount = TY2026_EXPECTED_SECTION_RULE_COUNTS[expectedSection];
    if (actualSectionCount !== expectedSectionCount) {
      errors.push(
        `Section ${expectedSection}: expected ${expectedSectionCount} rows, found ${actualSectionCount}`,
      );
    }
  }
  for (const section of sections) {
    if (!(TY2026_RATE_CARD_SECTION_IDS as readonly string[]).includes(section)) {
      errors.push(`Unexpected section in catalog: ${section}`);
    }
  }
  for (let page = 1; page <= 14; page += 1) {
    if (!pages.has(page)) errors.push(`No catalog row mapped to PDF page ${page}`);
  }

  for (const item of TY2026_RATE_CARD_RULES) {
    for (const value of Object.values(item.rates)) {
      if (value?.kind === "REFERENCE" && !sections.has(value.section)) {
        errors.push(`${item.id}: missing referenced section ${value.section}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      taxYear: 2026,
      ruleCount: TY2026_RATE_CARD_RULES.length,
      sectionCount: sections.size,
      pageCount: pages.size,
      needsExternalDetailCount: TY2026_RATE_CARD_RULES.filter(
        (item) => item.implementationStatus === "NEEDS_EXTERNAL_DETAIL",
      ).length,
    },
  };
}
