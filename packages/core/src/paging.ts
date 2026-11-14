import { z } from "zod";

/**
 * Shared list parameters for every paginated screen. Values come from the URL, so they are
 * untrusted: anything out of range falls back to a safe default rather than failing.
 */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** Longest search text accepted; longer input is cut, not rejected. */
export const MAX_SEARCH_LENGTH = 100;

export interface PageRequest {
  page: number;
  pageSize: number;
  search: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  /** Number of pages, at least 1 so "page 1 of 1" reads correctly for an empty list. */
  pageCount: number;
}

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export function parsePageRequest(params: Record<string, unknown>): PageRequest {
  const page = z.coerce.number().int().min(1).max(100_000).catch(1).parse(first(params.page) ?? 1);
  const size = z.coerce.number().int().catch(DEFAULT_PAGE_SIZE).parse(first(params.size) ?? DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE;
  const raw = first(params.q);
  const search = typeof raw === "string" ? raw.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  return { page, pageSize, search };
}

export function toPage<T>(rows: T[], total: number, req: PageRequest): Page<T> {
  return { rows, total, page: req.page, pageSize: req.pageSize, pageCount: Math.max(1, Math.ceil(total / req.pageSize)) };
}

/** Escapes LIKE wildcards so a search for "50%" or "a_b" matches literally. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
