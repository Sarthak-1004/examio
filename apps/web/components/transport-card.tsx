import type { MyTransport } from "@examio/core";
import { EmptyState } from "./ui";

/** A student's current route and stop (student and parent views). */
export function TransportInfo({ t, empty }: { t: MyTransport | null; empty: string }) {
  if (!t) return <EmptyState title={empty} />;
  const rows: [string, string][] = [
    ["Route", t.route],
    ["Stop", t.stop],
    ["Pickup", t.pickup || "Not set"],
    ["Drop", t.drop || "Not set"],
    ["Vehicle", t.vehicle ?? "Not set"],
    ["Since", t.since],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="text-slate-500">{k}</dt>
          <dd className="font-medium text-slate-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
