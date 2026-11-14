import type { Metadata } from "next";
import { listBoards, listMediums } from "@examio/core";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { NewSchoolForm } from "./form";

export const metadata: Metadata = { title: "Add school" };

export default async function NewSchoolPage() {
  const s = await requirePlatformAdmin();
  const [boards, mediums] = await Promise.all([listBoards(db, s.ctx), listMediums(db, s.ctx)]);
  return (
    <>
      <PageHeader title="Add a school" description="Creates the school and its first School Admin account." />
      <NewSchoolForm
        boards={boards.map((b) => ({ id: b.id, name: b.name }))}
        mediums={mediums.map((m) => ({ id: m.id, name: m.name }))}
      />
    </>
  );
}
