import type { Metadata } from "next";
import { listBoards, listMediums } from "@examio/core";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { toggleLookupAction } from "@/app/admin/actions";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { AddLookupForm } from "./add-form";

export const metadata: Metadata = { title: "Boards & mediums" };

export default async function SettingsPage() {
  const s = await requirePlatformAdmin();
  const [boards, mediums] = await Promise.all([
    listBoards(db, s.ctx, { includeInactive: true }),
    listMediums(db, s.ctx, { includeInactive: true }),
  ]);

  const section = (kind: "board" | "medium", title: string, items: { id: string; name: string; active: boolean }[]) => (
    <Card>
      <CardHeader title={title} description="Hidden items stay on existing schools but can't be chosen for new ones." />
      <div className="p-5">
        <AddLookupForm kind={kind} />
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-100">
        {items.map((it) => (
          <li key={it.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
            <span className={it.active ? "text-slate-900" : "text-slate-400"}>
              {it.name} {!it.active && <Badge>hidden</Badge>}
            </span>
            <form action={toggleLookupAction}>
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="id" value={it.id} />
              <input type="hidden" name="active" value={String(!it.active)} />
              <button className="rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50">
                {it.active ? "Hide" : "Show"}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </Card>
  );

  return (
    <>
      <PageHeader title="Boards & mediums" description="Options offered when adding a school." />
      <div className="grid gap-6 lg:grid-cols-2">
        {section("board", "Boards / curricula", boards)}
        {section("medium", "Mediums of instruction", mediums)}
      </div>
    </>
  );
}
