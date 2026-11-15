import type { Metadata } from "next";
import Link from "next/link";
import { getMyTeaching, listAcademicYears, listAnnouncementsForStaff, listClasses, listSections } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea, cx } from "@/components/ui";
import { RowAction, chooseYear } from "../setup/shared";
import { sectionOptions } from "../students/shared";
import { archiveNoticeAction, publishNoticeAction } from "./actions";

export const metadata: Metadata = { title: "Notices" };

const AUDIENCE_LABEL: Record<string, string> = { everyone: "Everyone", staff: "Staff", students: "Students", parents: "Parents", section: "Class" };
const when = (d: Date) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function NoticesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSchoolRole("school_admin", "teacher");
  const schoolId = s.ctx.schoolId;
  const isAdmin = s.roles.includes("school_admin");
  const sp = await searchParams;
  const archived = sp.view === "archived";
  const notices = await listAnnouncementsForStaff(db, s.ctx, schoolId, { archived });
  let sections: { id: string; label: string }[];
  if (isAdmin) {
    const [years, classes] = await Promise.all([listAcademicYears(db, s.ctx, schoolId), listClasses(db, s.ctx, schoolId)]);
    const year = chooseYear(years, undefined);
    sections = year ? sectionOptions(await listSections(db, s.ctx, schoolId, year.id), classes) : [];
  } else {
    const t = await getMyTeaching(db, s.ctx, schoolId);
    const seen = new Map<string, string>();
    for (const x of [...t.subjects, ...t.classTeacherOf]) seen.set(x.sectionId, x.label);
    sections = [...seen.entries()].map(([id, label]) => ({ id, label }));
  }

  return (
    <>
      <PageHeader title="Notices" description={isAdmin ? "Notices to the whole school, a group or a class. Recipients are notified in the app and by email." : "Notices to the sections you teach. Students and their parents are notified."} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <nav aria-label="Notice list" className="flex gap-2 border-b border-slate-100 px-5 py-3 text-sm">
            <Link href="/school/announcements" aria-current={!archived ? "page" : undefined} className={cx("rounded-md px-3 py-2", !archived ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50")}>
              Current
            </Link>
            <Link href="/school/announcements?view=archived" aria-current={archived ? "page" : undefined} className={cx("rounded-md px-3 py-2", archived ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-50")}>
              Archived
            </Link>
          </nav>
          {notices.length === 0 ? (
            <EmptyState title={archived ? "Nothing archived" : "No notices"}>{archived ? "Archived notices appear here." : "Publish the first notice with the form."}</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {notices.map((n) => (
                <li key={n.id} className="space-y-1 px-5 py-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">{n.title}</span>
                    <Badge tone="blue">{n.audience === "section" ? n.sectionLabel : AUDIENCE_LABEL[n.audience]}</Badge>
                  </div>
                  <p className="whitespace-pre-wrap text-slate-700">{n.body}</p>
                  <p className="text-xs text-slate-500">
                    {n.authorName} · {when(n.publishedAt)}
                    {n.delivery ? ` · ${n.delivery.recipients} recipient(s), ${n.delivery.delivered} delivered, ${n.delivery.pending} pending${n.delivery.failed ? `, ${n.delivery.failed} failed` : ""}, ${n.delivery.read} read` : ""}
                  </p>
                  {!archived && (n.mine || isAdmin) && <RowAction action={archiveNoticeAction} fields={{ announcementId: n.id }} label="Archive" variant="ghost" ariaLabel={`Archive ${n.title}`} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Publish a notice" />
          {!isAdmin && sections.length === 0 ? (
            <p className="p-5 text-sm text-slate-600">You have no classes assigned today.</p>
          ) : (
            <ActionForm action={publishNoticeAction} className="space-y-4 p-5">
              {isAdmin && (
                <Field label="To" htmlFor="nt-audience" hint="For a class, also choose the section.">
                  <Select id="nt-audience" name="audience" defaultValue="everyone">
                    <option value="everyone">Everyone</option>
                    <option value="staff">Staff</option>
                    <option value="students">Students</option>
                    <option value="parents">Parents</option>
                    <option value="section">One class (students and parents)</option>
                  </Select>
                </Field>
              )}
              {!isAdmin && <input type="hidden" name="audience" value="section" />}
              <Field label="Class" htmlFor="nt-section">
                <Select id="nt-section" name="sectionId" defaultValue={isAdmin ? "" : sections[0]?.id}>
                  {isAdmin && <option value="">Not a class notice</option>}
                  {sections.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Title" htmlFor="nt-title">
                <Input id="nt-title" name="title" required maxLength={150} />
              </Field>
              <Field label="Message" htmlFor="nt-body">
                <Textarea id="nt-body" name="body" rows={5} required maxLength={5000} />
              </Field>
              <SubmitButton pendingText="Publishing…">Publish notice</SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
