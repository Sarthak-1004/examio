export const OFFLINE_STATUS: Record<string, { label: string; tone: "amber" | "blue" | "slate" | "green" }> = {
  draft: { label: "Entering marks", tone: "amber" },
  submitted: { label: "Submitted", tone: "blue" },
  locked: { label: "Locked", tone: "slate" },
  released: { label: "Released", tone: "green" },
};

/** "45.5", "AB", "EX" or "" for an entry. */
export function entryText(status: string | null, marksX100: number | null): string {
  if (status === "present" && marksX100 !== null) return String(marksX100 / 100);
  if (status === "absent") return "AB";
  if (status === "exempt") return "EX";
  return "";
}

export const pct = (bp: number | null) => (bp === null ? "—" : `${(bp / 100).toFixed(2)}%`);
