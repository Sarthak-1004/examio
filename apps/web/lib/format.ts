/**
 * Date and time display. Instants are shown in the school's own time zone (from the session),
 * so a school outside India sees its local times. Platform pages, which belong to no school,
 * use India time and say so.
 */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** "18 Nov 2026, 10:30 am" in the given time zone. */
export function formatDateTime(at: Date | string, timeZone: string = DEFAULT_TIME_ZONE, opts: { seconds?: boolean; long?: boolean } = {}): string {
  return new Date(at).toLocaleString("en-IN", { dateStyle: opts.long ? "long" : "medium", timeStyle: opts.seconds ? "medium" : "short", timeZone });
}
