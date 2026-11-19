import type { Metadata } from "next";
import { getMyTransport } from "@examio/core";
import { TransportInfo } from "@/components/transport-card";
import { Card, PageHeader } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Transport" };

export default async function MyTransportPage() {
  const s = await requireSchoolRole("student");
  const t = await getMyTransport(db, s.ctx, s.ctx.schoolId);
  return (
    <>
      <PageHeader title="Transport" description="Your school bus route and stop. Ask the school office to change them." />
      <Card>
        <TransportInfo t={t} empty="You are not on a school transport route." />
      </Card>
    </>
  );
}
