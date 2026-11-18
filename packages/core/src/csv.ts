/**
 * CSV for imports and exports (RFC 4180: commas, double-quoted fields, doubled quotes, CRLF or LF).
 *
 * Exports neutralise spreadsheet formulas: a value starting with = + - @ or a tab/carriage
 * return is prefixed with an apostrophe, so opening the file in a spreadsheet never runs it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            // Only text can carry a formula; a negative number must stay a number ("-5", not "'-5").
            const s = typeof v === "number" ? String(v) : neutralizeCell(v ?? "");
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}
