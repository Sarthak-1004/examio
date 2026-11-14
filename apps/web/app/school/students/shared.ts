import type { SchoolClass, Section } from "@examio/core";

/** "Class 7 A"-style options for a year's sections, in natural class order. */
export function sectionOptions(sections: Section[], classes: SchoolClass[]): { id: string; label: string }[] {
  const className = new Map(classes.map((c) => [c.id, c.name]));
  return sections
    .filter((x) => className.has(x.classId))
    .map((x) => ({ id: x.id, label: `${className.get(x.classId)} ${x.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export const RELATIONSHIP_LABEL: Record<string, string> = { mother: "Mother", father: "Father", guardian: "Guardian", other: "Other" };
export const LEAVE_LABEL: Record<string, string> = { withdrawn: "Withdrawn", transferred: "Transferred", graduated: "Graduated", other: "Other" };
export const END_LABEL: Record<string, string> = { promoted: "Promoted", section_changed: "Moved section", left: "Left", corrected: "Correction" };
