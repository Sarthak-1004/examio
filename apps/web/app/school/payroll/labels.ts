/** Display helpers shared by the payroll pages. */
export const CALC_LABEL: Record<string, string> = {
  fixed: "Fixed amount",
  percent_basic: "% of basic",
  percent_gross: "% of gross",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-01" → "October 2026". */
export function monthLabel(periodStart: string): string {
  return `${MONTHS[Number(periodStart.slice(5, 7)) - 1] ?? ""} ${periodStart.slice(0, 4)}`;
}
