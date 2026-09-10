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
 * Every row id ever observed as a rendered IRIS grid row. 43 rows from
 * the captures folder as of generation time.
 */
export const PORTAL_ROW_EVIDENCE: Record<string, PortalRowEvidence> = {
  "1000": { writeableInputIndexes: [], captureCount: 2 },
  "1008": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "1009": { writeableInputIndexes: [0], captureCount: 2 },
  "1010": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "1049": { writeableInputIndexes: [0], captureCount: 2 },
  "1059": { writeableInputIndexes: [0], captureCount: 2 },
  "1089": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "1099": { writeableInputIndexes: [0, 1], captureCount: 2 },
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
  "9201": { writeableInputIndexes: [], captureCount: 2 },
  "9210": { writeableInputIndexes: [], captureCount: 2 },
  "92101": { writeableInputIndexes: [0], captureCount: 2 },
  "700302": { writeableInputIndexes: [], captureCount: 1 },
  "703000": { writeableInputIndexes: [], captureCount: 3 },
  "703001": { writeableInputIndexes: [], captureCount: 4 },
  "703002": { writeableInputIndexes: [0], captureCount: 3 },
  "703003": { writeableInputIndexes: [], captureCount: 3 },
  "923184": { writeableInputIndexes: [0], captureCount: 2 },
  "923198": { writeableInputIndexes: [0, 1], captureCount: 2 },
  "999901": { writeableInputIndexes: [], captureCount: 1 },
  "999902": { writeableInputIndexes: [], captureCount: 1 },
  "999903": { writeableInputIndexes: [], captureCount: 1 },
  "999905": { writeableInputIndexes: [], captureCount: 2 },
  "9231822": { writeableInputIndexes: [0], captureCount: 2 },
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
