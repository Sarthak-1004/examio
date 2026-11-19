import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getRoute, listVehicles, type RouteDetail } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { addStopAction, archiveRouteAction, assignAction, endAssignmentAction, updateRouteAction, updateStopAction } from "../../actions";

export const metadata: Metadata = { title: "Route" };

type Stop = RouteDetail["stops"][number];
type Rider = RouteDetail["students"][number];

function StopFields({ prefix, stop }: { prefix: string; stop?: Stop }) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Field label="Position" htmlFor={`${prefix}-seq`}>
        <Input id={`${prefix}-seq`} name="sequence" type="number" min={1} max={99} required defaultValue={stop?.sequence} />
      </Field>
      <Field label="Stop name" htmlFor={`${prefix}-name`} className="sm:col-span-3">
        <Input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={stop?.name} />
      </Field>
      <Field label="Pickup time (optional)" htmlFor={`${prefix}-pickup`} className="sm:col-span-2">
        <Input id={`${prefix}-pickup`} name="pickup" type="time" defaultValue={stop?.pickup} />
      </Field>
      <Field label="Drop time (optional)" htmlFor={`${prefix}-drop`} className="sm:col-span-2">
        <Input id={`${prefix}-drop`} name="drop" type="time" defaultValue={stop?.drop} />
      </Field>
    </div>
  );
}

export default async function RoutePage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin");
  const { id } = await params;
  const [route, vehicles] = await Promise.all([
    getRoute(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
      if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
      throw e;
    }),
    listVehicles(db, s.ctx, s.ctx.schoolId),
  ]);
  const full = route.capacity !== null && route.students.length >= route.capacity;

  const stopColumns: Column<Stop>[] = [
    { key: "seq", header: "No.", cell: (st) => st.sequence },
    { key: "name", header: "Stop", primary: true, cell: (st) => st.name },
    { key: "times", header: "Pickup · drop", cell: (st) => [st.pickup, st.drop].map((t) => t || "—").join(" · ") },
    { key: "students", header: "Students", align: "right", cell: (st) => st.students },
    {
      key: "edit",
      header: "Actions",
      cell: (st) => (
        <details className="text-sm">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-slate-700 hover:bg-slate-100">{`Edit ${st.name}`}</summary>
          <ActionForm action={updateStopAction} keepValues className="mt-2 w-72 space-y-3">
            <input type="hidden" name="stopId" value={st.id} />
            <StopFields prefix={`stop-${st.id}`} stop={st} />
            <SubmitButton variant="secondary" pendingText="Saving…">Save stop</SubmitButton>
          </ActionForm>
        </details>
      ),
    },
  ];
  const riderColumns: Column<Rider>[] = [
    { key: "name", header: "Student", primary: true, cell: (r) => `${r.name} (${r.admissionNo})` },
    { key: "class", header: "Class", secondary: true, cell: (r) => r.sectionLabel ?? "—" },
    { key: "stop", header: "Stop", cell: (r) => r.stop },
    { key: "since", header: "Since", secondary: true, cell: (r) => r.startsOn },
    {
      key: "end",
      header: "Actions",
      cell: (r) => (
        <ActionForm action={endAssignmentAction} inline>
          <input type="hidden" name="assignmentId" value={r.assignmentId} />
          <SubmitButton variant="ghost" pendingText="Ending…" aria-label={`End transport for ${r.name}`}>
            End
          </SubmitButton>
        </ActionForm>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={route.name}
        description={[route.vehicle ? `${route.vehicle} · ${route.students.length} of ${route.capacity} seats taken` : "No vehicle yet: students cannot be assigned", route.archived ? "archived" : null].filter(Boolean).join(" · ")}
        action={
          <span className="flex flex-wrap gap-4 text-sm font-medium">
            <a href={`/school/transport/export?route=${route.id}`} className="text-brand-700 hover:underline">
              Download list (CSV)
            </a>
            <Link href="/school/transport" className="text-brand-700 hover:underline">
              Transport
            </Link>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Students" action={full ? <Badge tone="red">Full</Badge> : undefined} />
            <DataTable caption="Students on this route" columns={riderColumns} rows={route.students} rowKey={(r) => r.assignmentId} empty={{ title: "No students on this route" }} />
          </Card>
          <Card>
            <CardHeader title="Stops" />
            <DataTable caption="Stops" columns={stopColumns} rows={route.stops} rowKey={(st) => st.id} empty={{ title: "No stops yet", body: "Add the stops in order." }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {!route.archived && (
            <Card>
              <CardHeader title="Assign a student" description="A student already on a route is moved here; the old assignment ends today." />
              {route.stops.length === 0 ? (
                <p className="p-5 text-sm text-slate-600">Add a stop first.</p>
              ) : (
                <ActionForm action={assignAction} className="space-y-4 p-5">
                  <input type="hidden" name="routeId" value={route.id} />
                  <Field label="Admission number" htmlFor="assign-adm">
                    <Input id="assign-adm" name="admissionNo" required autoComplete="off" />
                  </Field>
                  <Field label="Stop" htmlFor="assign-stop">
                    <Select id="assign-stop" name="stopId" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {route.stops.map((st) => (
                        <option key={st.id} value={st.id}>{`${st.sequence}. ${st.name}`}</option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton pendingText="Assigning…">Assign</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
          {!route.archived && (
            <Card>
              <CardHeader title="Add a stop" />
              <ActionForm action={addStopAction} className="space-y-4 p-5">
                <input type="hidden" name="routeId" value={route.id} />
                <StopFields prefix="new-stop" />
                <SubmitButton pendingText="Adding…">Add stop</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card>
            <CardHeader title="Route details" />
            <ActionForm action={updateRouteAction} keepValues className="space-y-4 p-5">
              <input type="hidden" name="routeId" value={route.id} />
              <Field label="Route name" htmlFor="ed-name">
                <Input id="ed-name" name="name" required maxLength={80} defaultValue={route.name} />
              </Field>
              <Field label="Vehicle" htmlFor="ed-vehicle">
                <Select id="ed-vehicle" name="vehicleId" defaultValue={route.vehicleId ?? ""}>
                  <option value="">None</option>
                  {vehicles
                    .filter((v) => !v.archived || v.id === route.vehicleId)
                    .map((v) => (
                      <option key={v.id} value={v.id}>{`${v.registrationNo} (${v.capacity} seats)`}</option>
                    ))}
                </Select>
              </Field>
              <Field label="Driver's employee number" htmlFor="ed-driver" hint={route.driver ?? undefined}>
                <Input id="ed-driver" name="driver" autoComplete="off" defaultValue={route.driverNo ?? ""} />
              </Field>
              <Field label="Attendant's employee number" htmlFor="ed-attendant" hint={route.attendant ?? undefined}>
                <Input id="ed-attendant" name="attendant" autoComplete="off" defaultValue={route.attendantNo ?? ""} />
              </Field>
              <SubmitButton pendingText="Saving…">Save route</SubmitButton>
            </ActionForm>
            <ActionForm action={archiveRouteAction} className="border-t border-slate-100 p-5">
              <input type="hidden" name="routeId" value={route.id} />
              <input type="hidden" name="archived" value={route.archived ? "0" : "1"} />
              <SubmitButton variant="secondary" pendingText="Saving…">
                {route.archived ? "Restore route" : "Archive route"}
              </SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
