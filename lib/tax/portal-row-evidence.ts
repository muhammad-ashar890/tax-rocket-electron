// GENERATED — do not edit by hand.
// Source: the portal capture folder, via:
//   npm run inventory:portal-coverage -- --emit-evidence
// Regenerate it whenever new IRIS captures land; that is the ONLY way an IRIS code
// becomes eligible for auto-fill in lib/tax/portal-field-map.ts.

/** What a captured IRIS grid row allowed a human to do. */
export type PortalRowEvidence = {
  /**
   * Indexes of the row's <input> elements that were NOT disabled — the cells a
   * person could actually type into. Empty means the row renders but IRIS
   * computes it, so nothing may be entered there.
   */
  writeableInputIndexes: number[];
  /** How many capture files showed this row (1 = single sighting). */
  captureCount: number;
};

/**
 * Every row id ever observed as a rendered IRIS grid row. 72 rows from
 * the captures folder as of generation time.
 */
export const PORTAL_ROW_EVIDENCE: Record<string, PortalRowEvidence> = {
  "1000": { writeableInputIndexes: [], captureCount: 3 },
  "1008": { writeableInputIndexes: [0, 1, 2], captureCount: 3 },
  "1009": { writeableInputIndexes: [0, 2], captureCount: 3 },
  "1010": { writeableInputIndexes: [0, 1, 2], captureCount: 3 },
  "1049": { writeableInputIndexes: [0, 2], captureCount: 3 },
  "1059": { writeableInputIndexes: [0, 2], captureCount: 3 },
  "1089": { writeableInputIndexes: [0, 1, 2], captureCount: 3 },
  "1099": { writeableInputIndexes: [0, 1], captureCount: 3 },
  "2000": { writeableInputIndexes: [], captureCount: 1 },
  "2001": { writeableInputIndexes: [], captureCount: 1 },
  "2002": { writeableInputIndexes: [0], captureCount: 1 },
  "2003": { writeableInputIndexes: [0], captureCount: 1 },
  "2004": { writeableInputIndexes: [0, 1], captureCount: 1 },
  "2005": { writeableInputIndexes: [0, 1], captureCount: 1 },
  "2029": { writeableInputIndexes: [], captureCount: 1 },
  "2031": { writeableInputIndexes: [], captureCount: 1 },
  "2099": { writeableInputIndexes: [], captureCount: 1 },
  "7003": { writeableInputIndexes: [], captureCount: 1 },
  "7012": { writeableInputIndexes: [0], captureCount: 1 },
  "7013": { writeableInputIndexes: [], captureCount: 1 },
  "7014": { writeableInputIndexes: [], captureCount: 1 },
  "7019": { writeableInputIndexes: [], captureCount: 1 },
  "7021": { writeableInputIndexes: [], captureCount: 1 },
  "7029": { writeableInputIndexes: [], captureCount: 1 },
  "7031": { writeableInputIndexes: [0], captureCount: 3 },
  "7032": { writeableInputIndexes: [0], captureCount: 3 },
  "7033": { writeableInputIndexes: [0], captureCount: 3 },
  "7034": { writeableInputIndexes: [], captureCount: 3 },
  "7035": { writeableInputIndexes: [], captureCount: 3 },
  "7036": { writeableInputIndexes: [], captureCount: 3 },
  "7037": { writeableInputIndexes: [], captureCount: 3 },
  "7049": { writeableInputIndexes: [], captureCount: 3 },
  "7088": { writeableInputIndexes: [0], captureCount: 3 },
  "7089": { writeableInputIndexes: [], captureCount: 3 },
  "7091": { writeableInputIndexes: [], captureCount: 3 },
  "7098": { writeableInputIndexes: [], captureCount: 3 },
  "7099": { writeableInputIndexes: [], captureCount: 3 },
  "9009": { writeableInputIndexes: [], captureCount: 1 },
  "9201": { writeableInputIndexes: [], captureCount: 2 },
  "9210": { writeableInputIndexes: [], captureCount: 2 },
  "9309": { writeableInputIndexes: [], captureCount: 1 },
  "9329": { writeableInputIndexes: [], captureCount: 1 },
  "92101": { writeableInputIndexes: [0], captureCount: 2 },
  "640000": { writeableInputIndexes: [], captureCount: 1 },
  "700302": { writeableInputIndexes: [], captureCount: 1 },
  "703000": { writeableInputIndexes: [], captureCount: 3 },
  "703001": { writeableInputIndexes: [], captureCount: 4 },
  "703002": { writeableInputIndexes: [0], captureCount: 3 },
  "703003": { writeableInputIndexes: [], captureCount: 3 },
  "923184": { writeableInputIndexes: [0], captureCount: 2 },
  "923198": { writeableInputIndexes: [0, 1, 2], captureCount: 2 },
  "999901": { writeableInputIndexes: [], captureCount: 1 },
  "999902": { writeableInputIndexes: [], captureCount: 1 },
  "999903": { writeableInputIndexes: [], captureCount: 1 },
  "999905": { writeableInputIndexes: [], captureCount: 2 },
  "999909": { writeableInputIndexes: [], captureCount: 2 },
  "999910": { writeableInputIndexes: [], captureCount: 2 },
  "999911": { writeableInputIndexes: [], captureCount: 2 },
  "999912": { writeableInputIndexes: [], captureCount: 1 },
  "9231822": { writeableInputIndexes: [0], captureCount: 2 },
  "64000101": { writeableInputIndexes: [], captureCount: 1 },
  "64000102": { writeableInputIndexes: [], captureCount: 1 },
  "64000103": { writeableInputIndexes: [], captureCount: 1 },
  "64020004": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "64020005": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "64020007": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "64080001": { writeableInputIndexes: [0, 1], captureCount: 1 },
  "64150002": { writeableInputIndexes: [0, 1], captureCount: 1 },
  "64151905": { writeableInputIndexes: [0, 1], captureCount: 1 },
  "64210051": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "64210054": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "64210056": { writeableInputIndexes: [0, 1], captureCount: 2 },
};

/** Row ids proven writeable — the packet map may only target these. */
export const PORTAL_WRITEABLE_CODES: ReadonlySet<string> = new Set(
  Object.entries(PORTAL_ROW_EVIDENCE)
    .filter(([, evidence]) => evidence.writeableInputIndexes.length > 0)
    .map(([code]) => code),
);

/** Row ids that render but are computed by IRIS: present, never enterable. */
export const PORTAL_DISABLED_CODES: ReadonlySet<string> = new Set(
  Object.entries(PORTAL_ROW_EVIDENCE)
    .filter(([, evidence]) => evidence.writeableInputIndexes.length === 0)
    .map(([code]) => code),
);

export function portalCodeHasCaptureEvidence(code: string): boolean {
  return PORTAL_WRITEABLE_CODES.has(String(code));
}
