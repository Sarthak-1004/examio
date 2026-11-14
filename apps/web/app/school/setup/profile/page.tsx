import type { Metadata } from "next";
import { getSchool, getSchoolProfile } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { saveProfileAction } from "../actions";

export const metadata: Metadata = { title: "School profile" };

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Kathmandu", "Asia/Dhaka", "Asia/Singapore", "Europe/London", "UTC"];

export default async function ProfilePage() {
  const s = await requireSchoolRole("school_admin");
  const [profile, school] = await Promise.all([getSchoolProfile(db, s.ctx, s.ctx.schoolId), getSchool(db, s.ctx, s.ctx.schoolId)]);
  return (
    <>
      <PageHeader title="School profile" description="How your school appears in Examio, and how people can contact it." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <ActionForm action={saveProfileAction} keepValues className="space-y-5 p-5">
            <Field label="School name" htmlFor="name">
              <Input id="name" name="name" required minLength={3} maxLength={200} defaultValue={profile.name} />
            </Field>
            <Field label="Short name" htmlFor="shortName" hint="Optional, up to 30 characters, e.g. GVPS.">
              <Input id="shortName" name="shortName" maxLength={30} defaultValue={profile.shortName ?? ""} />
            </Field>
            <Field label="Address" htmlFor="address">
              <Input id="address" name="address" maxLength={500} defaultValue={profile.address ?? ""} />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Contact email" htmlFor="contactEmail">
                <Input id="contactEmail" name="contactEmail" type="email" defaultValue={profile.contactEmail ?? ""} />
              </Field>
              <Field label="Contact phone" htmlFor="contactPhone">
                <Input id="contactPhone" name="contactPhone" type="tel" defaultValue={profile.contactPhone ?? ""} />
              </Field>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Time zone" htmlFor="timezone" hint="Attendance dates and deadlines use this time zone.">
                <Input id="timezone" name="timezone" required list="zones" defaultValue={profile.timezone} />
              </Field>
              <Field label="Accent colour" htmlFor="brandColor" hint="Optional, e.g. #2953e0.">
                <Input id="brandColor" name="brandColor" type="color" defaultValue={profile.brandColor ?? "#2953e0"} className="h-11 p-1" />
              </Field>
            </div>
            <datalist id="zones">
              {ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <SubmitButton pendingText="Saving…">Save profile</SubmitButton>
          </ActionForm>
        </Card>
        <Card>
          <CardHeader title="Set by Examio" description="Contact platform support to change these." />
          <dl className="divide-y divide-slate-100 text-sm">
            {[
              ["School code", <span key="c" className="font-mono">{school.code}</span>],
              ["Board", school.board],
              ["Medium", school.medium],
              ["Status", school.status],
            ].map(([k, v]) => (
              <div key={String(k)} className="flex justify-between gap-4 px-5 py-3">
                <dt className="text-slate-500">{k}</dt>
                <dd className="text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}
