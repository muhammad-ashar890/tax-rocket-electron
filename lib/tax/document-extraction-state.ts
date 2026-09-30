/**
 * An extraction request owns the PROCESSING state for a short lease. A refresh
 * must not make the next request start a second Gemini call while the original
 * one is still running, but an abandoned lease must eventually be retryable.
 */
export const DOCUMENT_EXTRACTION_LEASE_MS = 5 * 60 * 1000;

export function isDocumentExtractionLeaseStale(
  status: string,
  startedAt: Date | string | null | undefined,
  now: Date | number = Date.now(),
) {
  if (status !== "PROCESSING") return false;
  if (!startedAt) return true;

  const startedAtMs =
    startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
  const nowMs = now instanceof Date ? now.getTime() : now;

  // A malformed/missing timestamp cannot prove that a worker is still alive.
  return !Number.isFinite(startedAtMs) || nowMs - startedAtMs >= DOCUMENT_EXTRACTION_LEASE_MS;
}
