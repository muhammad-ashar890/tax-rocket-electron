/** "2026-09-18" -> "18 Sep 2026". Parsed by hand so no time zone shifts the day. */
export function formatIsoDate(iso: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!match) return "";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[Number(match[2]) - 1];
  if (!month) return "";
  return `${Number(match[3])} ${month} ${match[1]}`;
}

export function statusLabel(status: string): string {
  return status === "DRAFT" ? "Draft" : status.replaceAll("_", " ").toLowerCase();
}
