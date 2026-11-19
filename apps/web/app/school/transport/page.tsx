import type { Metadata } from "next";
import Link from "next/link";
import { listRoutes, listVehicles, searchAssignments, type RouteRow, type VehicleRow } from "@examio/core";
import { ActionForm } from "@/components/action-form";
import { DataTable, type Column } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { archiveVehicleAction, createRouteAction, createVehicleAction, updateVehicleAction } from "./actions";

export const metadata: Metadata = { title: "Transport" };

export default async function TransportPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const s = await requireSchoolRole("school_admin");
  const schoolId = s.ctx.schoolId;
  const { q } = await searchParams;
  const search = (typeof q === "string" ? q : "").slice(0, 100);
  const [routes, vehicles, found] = await Promise.all([listRoutes(db, s.ctx, schoolId), listVehicles(db, s.ctx, schoolId), searchAssignments(db, s.ctx, schoolId, search)]);
  const activeVehicles = vehicles.filter((v) => !v.archived);

  const routeColumns: Column<RouteRow>[] = [
    {
      key: "name",
      header: "Route",
      primary: true,
      cell: (r) => (
        <Link href={`/school/transport/routes/${r.id}`} className="text-brand-700 hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: "vehicle", header: "Vehicle", cell: (r) => r.vehicle ?? <Badge tone="amber">No vehicle</Badge> },
    {
      key: "seats",
      header: "Students",
      cell: (r) =>
        r.archived ? <Badge>Archived</Badge> : r.capacity !== null && r.occupancy >= r.capacity ? <Badge tone="red">{`${r.occupancy} of ${r.capacity} · full`}</Badge> : `${r.occupancy}${r.capacity !== null ? ` of ${r.capacity}` : ""}`,
    },
    { key: "stops", header: "Stops", secondary: true, align: "right", cell: (r) => r.stops },
    { key: "crew", header: "Driver · attendant", secondary: true, cell: (r) => [r.driver, r.attendant].filter(Boolean).join(" · ") || "—" },
  ];
  const vehicleColumns: Column<VehicleRow>[] = [
    { key: "reg", header: "Registration", primary: true, cell: (v) => v.registrationNo },
    { key: "routes", header: "Routes", secondary: true, cell: (v) => (v.archived ? <Badge>Archived</Badge> : (v.routes ?? "—")) },
    {
      key: "seats",
      header: "Seats",
      cell: (v) =>
        v.archived ? (
          v.capacity
        ) : (
          <ActionForm action={updateVehicleAction} inline keepValues>
            <input type="hidden" name="vehicleId" value={v.id} />
            <input type="hidden" name="description" value={v.description ?? ""} />
            <label className="sr-only" htmlFor={`cap-${v.id}`}>{`Seats in ${v.registrationNo}`}</label>
            <Input id={`cap-${v.id}`} name="capacity" type="number" min={1} max={100} defaultValue={v.capacity} className="w-20" />
            <SubmitButton variant="secondary" pendingText="Saving…" aria-label={`Save seats for ${v.registrationNo}`}>
              Save
            </SubmitButton>
          </ActionForm>
        ),
    },
    {
      key: "archive",
      header: "Actions",
      cell: (v) => (
        <ActionForm action={archiveVehicleAction} inline>
          <input type="hidden" name="vehicleId" value={v.id} />
          <input type="hidden" name="archived" value={v.archived ? "0" : "1"} />
          <SubmitButton variant="ghost" pendingText="Saving…" aria-label={`${v.archived ? "Restore" : "Archive"} ${v.registrationNo}`}>
            {v.archived ? "Restore" : "Archive"}
          </SubmitButton>
        </ActionForm>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Transport"
        description="Routes, stops and vehicles. A route never takes more students than its vehicle has seats."
        action={
          <a href="/school/transport/export" className="text-sm font-medium text-brand-700 hover:underline">
            Download all routes (CSV)
          </a>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Routes" />
            <DataTable caption="Routes" columns={routeColumns} rows={routes} rowKey={(r) => r.id} empty={{ title: "No routes yet", body: "Add a vehicle, then a route." }} />
          </Card>
          <Card>
            <CardHeader title="Find a student" description="Which route and stop a student is on." />
            <FilterBar basePath="/school/transport" search={search} searchLabel="Student name or admission number" />
            {search && (
              <DataTable
                caption="Students on routes"
                columns={[
                  { key: "name", header: "Student", primary: true, cell: (r) => `${r.name} (${r.admissionNo})` },
                  { key: "route", header: "Route", cell: (r) => <Link href={`/school/transport/routes/${r.routeId}`} className="text-brand-700 hover:underline">{r.route}</Link> },
                  { key: "stop", header: "Stop", cell: (r) => r.stop },
                ]}
                rows={found}
                rowKey={(r) => r.assignmentId}
                empty={{ title: "Not on any route", body: "Assign the student from a route's page." }}
              />
            )}
          </Card>
          <Card>
            <CardHeader title="Vehicles" />
            <DataTable caption="Vehicles" columns={vehicleColumns} rows={vehicles} rowKey={(v) => v.id} empty={{ title: "No vehicles yet" }} />
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Add a route" />
            <ActionForm action={createRouteAction} className="space-y-4 p-5">
              <Field label="Route name" htmlFor="route-name">
                <Input id="route-name" name="name" required maxLength={80} />
              </Field>
              <Field label="Vehicle (optional)" htmlFor="route-vehicle">
                <Select id="route-vehicle" name="vehicleId" defaultValue="">
                  <option value="">None yet</option>
                  {activeVehicles.map((v) => (
                    <option key={v.id} value={v.id}>{`${v.registrationNo} (${v.capacity} seats)`}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Driver's employee number (optional)" htmlFor="route-driver">
                <Input id="route-driver" name="driver" autoComplete="off" />
              </Field>
              <Field label="Attendant's employee number (optional)" htmlFor="route-attendant">
                <Input id="route-attendant" name="attendant" autoComplete="off" />
              </Field>
              <SubmitButton pendingText="Adding…">Add route</SubmitButton>
            </ActionForm>
          </Card>
          <Card>
            <CardHeader title="Add a vehicle" />
            <ActionForm action={createVehicleAction} className="space-y-4 p-5">
              <Field label="Registration number" htmlFor="veh-reg">
                <Input id="veh-reg" name="registrationNo" required maxLength={20} autoComplete="off" />
              </Field>
              <Field label="Seats for students" htmlFor="veh-cap">
                <Input id="veh-cap" name="capacity" type="number" min={1} max={100} required />
              </Field>
              <Field label="Description (optional)" htmlFor="veh-desc">
                <Input id="veh-desc" name="description" maxLength={120} />
              </Field>
              <SubmitButton pendingText="Adding…">Add vehicle</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
