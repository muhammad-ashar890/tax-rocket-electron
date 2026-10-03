"use strict";

/**
 * Remembers what Cash in hand (IRIS row 7012) held BEFORE this agent first
 * added the cash movement to it, and what the agent wrote.
 *
 * Why it exists: the packet carries a movement, not a balance. Without a
 * record a second run would see the figure the first run wrote and add the
 * movement again. With `{ existing, written }` the driver can tell "my own
 * earlier write" (safe to re-evaluate) from "somebody edited it" (never
 * touched).
 *
 * Scope: one JSON file in the agent log folder, keyed by taxpayer and tax year.
 * It lives on this machine only. A re-run from a different machine has no
 * record, treats the figure on screen as the baseline and would add the
 * movement once more; the wealth driver logs which baseline it used.
 */

const FILE_NAME = "cash-baseline.json";

function keyFor(taxpayerIdentifier, taxYear) {
  const who = String(taxpayerIdentifier || "").replace(/[^0-9A-Za-z]/g, "");
  const year = String(taxYear || "").replace(/[^0-9]/g, "");
  return who && year ? `${who}:${year}` : "";
}

function createCashBaselineStore({ dir, taxpayerIdentifier, taxYear, fs, path }) {
  const key = keyFor(taxpayerIdentifier, taxYear);
  const file = path.join(dir, FILE_NAME);
  const readAll = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    key,
    file,
    /** The saved record for this taxpayer and year, or null. */
    load() {
      if (!key) return null;
      const entry = readAll()[key];
      return entry && typeof entry === "object" ? entry : null;
    },
    /** Persist `{ existing, written, delta }`. Throws if it cannot be saved. */
    save(record) {
      if (!key) throw new Error("no taxpayer or tax year to key the baseline on");
      const all = readAll();
      all[key] = {
        existing: Number(record.existing),
        written: Number(record.written),
        delta: Number(record.delta),
        savedAt: new Date().toISOString(),
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

module.exports = { FILE_NAME, keyFor, createCashBaselineStore };
