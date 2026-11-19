import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { transportAssignments, transportRoutes, transportStops, transportVehicles, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { toCsv } from "../../csv";
import { schoolToday } from "../../dates";
import { checkViolation, uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { likePattern } from "../../paging";
import { parse, trimmed, uuidField } from "../setup/common";

/**
 * Transport (Phase 13.4), run by school administrators.
 *
 * - Vehicles (registration, seats), routes (optional vehicle, driver and attendant from active
 *   staff) and ordered stops with pickup and drop times (minutes after midnight, school time).
 * - A student has at most one active assignment (route and stop); assigning again ends the old
 *   one the same day. The route's occupancy can never exceed its vehicle's capacity: the database
 *   checks it on every assignment, vehicle change and capacity change (see 0026_transport).
 * - Students see their own route and stop; parents their linked children's.
 */

const CAP = "school.transport.manage";
const optionalText = (label: string, max: number) => z.union([z.literal("").transform(() => null), trimmed(label, 1, max)]).nullable().optional();
const registration = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 -]{0,19}$/, "Registration: up to 20 letters, digits, spaces or hyphens.");
const capacityField = z.coerce.number({ message: "Seats: enter a whole number." }).int("Seats: enter a whole number.").min(1, "Seats: 1 to 100.").max(100, "Seats: 1 to 100.");

/** "07:35" → 455; "" → null. */
export function parseClock(value: string | undefined, label: string): number | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new AppError("VALIDATION", `${label}: enter a time like 07:35.`, { [label === "Pickup time" ? "pickup" : "drop"]: "Not a time." });
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatClock(minute: number | null): string {
  if (minute === null) return "";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Maps the database's capacity and conflict refusals to messages. */
function mapTransportError(e: unknown): never {
  const check = checkViolation(e);
  if (check === "transport_capacity") throw new AppError("CONFLICT", "That would put more students on the route than the vehicle has seats.");
  if (check === "transport_route_no_vehicle") throw new AppError("CONFLICT", "Give the route a vehicle first.");
  if (check === "transport_route_archived") throw new AppError("CONFLICT", "This route is archived.");
  if (check === "transport_route_in_use") throw new AppError("CONFLICT", "Students are still on this route. End their assignments first.");
  if (check === "transport_vehicle_in_use") throw new AppError("CONFLICT", "A route still uses this vehicle.");
  const unique = uniqueViolation(e);
  if (unique?.includes("transport_vehicles_registration")) throw new AppError("CONFLICT", "A vehicle with this registration already exists.", { registrationNo: "Already used." });
  if (unique?.includes("transport_routes_name")) throw new AppError("CONFLICT", "A route with this name already exists.", { name: "Already used." });
  if (unique?.includes("transport_stops_sequence")) throw new AppError("CONFLICT", "Another stop on this route has that position.", { sequence: "Already used." });
  if (unique?.includes("transport_stops_name")) throw new AppError("CONFLICT", "Another stop on this route has that name.", { name: "Already used." });
  if (unique?.includes("transport_assignments_one_active")) throw new AppError("CONFLICT", "This student was just assigned by someone else. Reload and try again.");
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    mapTransportError(e);
  }
}

async function schoolDay(tx: Tx, schoolId: string): Promise<string> {
  const [s] = (await tx.execute(sql`select timezone from schools where id = ${schoolId}::uuid`)) as unknown as { timezone: string }[];
  return schoolToday(s?.timezone ?? "Asia/Kolkata");
}

/* ------------------------------------------------------------------ vehicles */

export interface VehicleRow {
  id: string;
  registrationNo: string;
  capacity: number;
  description: string | null;
  archived: boolean;
  routes: string | null;
}

export async function listVehicles(db: Db, ctx: RequestContext, schoolId: string): Promise<VehicleRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) =>
    (await tx.execute(sql`
      select v.id, v.registration_no as "registrationNo", v.capacity, v.description, v.archived_at is not null as archived,
             (select string_agg(r.name, ', ' order by lower(r.name)) from transport_routes r where r.vehicle_id = v.id and r.archived_at is null) as routes
      from transport_vehicles v where v.school_id = ${schoolId}::uuid order by v.archived_at is not null, v.registration_no`)) as unknown as VehicleRow[],
  );
}

export async function createVehicle(db: Db, ctx: RequestContext, schoolId: string, input: { registrationNo: string; capacity: string | number; description?: string }): Promise<{ id: string }> {
  const reg = parse(registration, input.registrationNo);
  const capacity = parse(capacityField, input.capacity);
  const description = parse(optionalText("Description", 120), input.description ?? "");
  return guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const [v] = await tx.insert(transportVehicles).values({ schoolId, registrationNo: reg, capacity, description: description ?? null }).returning({ id: transportVehicles.id });
      await audit(tx, { action: "transport.vehicle_added", actorUserId: actor.userId, schoolId, entityType: "transport_vehicle", entityId: v!.id, data: { registrationNo: reg, capacity } });
      return { id: v!.id };
    }),
  );
}

export async function updateVehicle(db: Db, ctx: RequestContext, schoolId: string, vehicleId: string, input: { capacity: string | number; description?: string }): Promise<void> {
  parse(uuidField("Vehicle"), vehicleId);
  const capacity = parse(capacityField, input.capacity);
  const description = parse(optionalText("Description", 120), input.description ?? "");
  await guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const r = await tx
        .update(transportVehicles)
        .set({ capacity, description: description ?? null })
        .where(and(eq(transportVehicles.schoolId, schoolId), eq(transportVehicles.id, vehicleId)))
        .returning({ id: transportVehicles.id });
      if (r.length === 0) throw new AppError("NOT_FOUND", "Vehicle not found.");
      await audit(tx, { action: "transport.vehicle_updated", actorUserId: actor.userId, schoolId, entityType: "transport_vehicle", entityId: vehicleId, data: { capacity } });
    }),
  );
}

export async function setVehicleArchived(db: Db, ctx: RequestContext, schoolId: string, vehicleId: string, archived: boolean): Promise<void> {
  parse(uuidField("Vehicle"), vehicleId);
  await guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const r = await tx
        .update(transportVehicles)
        .set({ archivedAt: archived ? sql`now()` : null })
        .where(and(eq(transportVehicles.schoolId, schoolId), eq(transportVehicles.id, vehicleId)))
        .returning({ id: transportVehicles.id });
      if (r.length === 0) throw new AppError("NOT_FOUND", "Vehicle not found.");
      await audit(tx, { action: archived ? "transport.vehicle_archived" : "transport.vehicle_restored", actorUserId: actor.userId, schoolId, entityType: "transport_vehicle", entityId: vehicleId });
    }),
  );
}

/* ------------------------------------------------------------------ routes */

async function staffByNumber(tx: Tx, schoolId: string, employeeNo: string | undefined, field: string): Promise<string | null> {
  const key = employeeNo?.trim() ?? "";
  if (!key) return null;
  const [s] = (await tx.execute(sql`select id, display_name as name, status::text as status from staff_profiles where school_id = ${schoolId}::uuid and lower(employee_no) = lower(${key})`)) as unknown as { id: string; name: string; status: string }[];
  if (!s) throw new AppError("NOT_FOUND", "No staff member has that employee number.", { [field]: "Not found." });
  if (s.status !== "active") throw new AppError("CONFLICT", `${s.name} has left the school.`, { [field]: "Not active." });
  return s.id;
}

async function activeVehicle(tx: Tx, schoolId: string, vehicleId: string | undefined): Promise<string | null> {
  if (!vehicleId) return null;
  parse(uuidField("Vehicle"), vehicleId);
  const [v] = await tx.select({ id: transportVehicles.id }).from(transportVehicles).where(and(eq(transportVehicles.schoolId, schoolId), eq(transportVehicles.id, vehicleId), isNull(transportVehicles.archivedAt)));
  if (!v) throw new AppError("NOT_FOUND", "Vehicle not found.", { vehicleId: "Choose a vehicle." });
  return v.id;
}

interface RouteInput {
  name: string;
  vehicleId?: string;
  driver?: string;
  attendant?: string;
}

async function routeValues(tx: Tx, schoolId: string, input: RouteInput) {
  const name = parse(trimmed("Route name", 1, 80), input.name);
  const vehicleId = await activeVehicle(tx, schoolId, input.vehicleId);
  const driverStaffId = await staffByNumber(tx, schoolId, input.driver, "driver");
  const attendantStaffId = await staffByNumber(tx, schoolId, input.attendant, "attendant");
  if (driverStaffId && driverStaffId === attendantStaffId) throw new AppError("VALIDATION", "The driver and the attendant must be different people.", { attendant: "Same as the driver." });
  return { name, vehicleId, driverStaffId, attendantStaffId };
}

export async function createRoute(db: Db, ctx: RequestContext, schoolId: string, input: RouteInput): Promise<{ id: string }> {
  return guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const v = await routeValues(tx, schoolId, input);
      const [r] = await tx.insert(transportRoutes).values({ schoolId, ...v }).returning({ id: transportRoutes.id });
      await audit(tx, { action: "transport.route_added", actorUserId: actor.userId, schoolId, entityType: "transport_route", entityId: r!.id, data: { name: v.name } });
      return { id: r!.id };
    }),
  );
}

export async function updateRoute(db: Db, ctx: RequestContext, schoolId: string, routeId: string, input: RouteInput): Promise<void> {
  parse(uuidField("Route"), routeId);
  await guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const v = await routeValues(tx, schoolId, input);
      const r = await tx
        .update(transportRoutes)
        .set({ ...v, updatedAt: sql`now()` })
        .where(and(eq(transportRoutes.schoolId, schoolId), eq(transportRoutes.id, routeId)))
        .returning({ id: transportRoutes.id });
      if (r.length === 0) throw new AppError("NOT_FOUND", "Route not found.");
      await audit(tx, { action: "transport.route_updated", actorUserId: actor.userId, schoolId, entityType: "transport_route", entityId: routeId, data: { vehicleId: v.vehicleId } });
    }),
  );
}

export async function setRouteArchived(db: Db, ctx: RequestContext, schoolId: string, routeId: string, archived: boolean): Promise<void> {
  parse(uuidField("Route"), routeId);
  await guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const r = await tx
        .update(transportRoutes)
        .set({ archivedAt: archived ? sql`now()` : null, updatedAt: sql`now()` })
        .where(and(eq(transportRoutes.schoolId, schoolId), eq(transportRoutes.id, routeId)))
        .returning({ id: transportRoutes.id });
      if (r.length === 0) throw new AppError("NOT_FOUND", "Route not found.");
      await audit(tx, { action: archived ? "transport.route_archived" : "transport.route_restored", actorUserId: actor.userId, schoolId, entityType: "transport_route", entityId: routeId });
    }),
  );
}

export interface RouteRow {
  id: string;
  name: string;
  vehicle: string | null;
  capacity: number | null;
  occupancy: number;
  stops: number;
  driver: string | null;
  attendant: string | null;
  archived: boolean;
}

const staffLabel = (alias: string) => sql.raw(`${alias}.display_name || ' (' || ${alias}.employee_no || ')'`);

export async function listRoutes(db: Db, ctx: RequestContext, schoolId: string): Promise<RouteRow[]> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) =>
    (await tx.execute(sql`
      select r.id, r.name, v.registration_no as vehicle, v.capacity, r.archived_at is not null as archived,
             (select count(*)::int from transport_assignments a where a.route_id = r.id and a.ended_on is null) as occupancy,
             (select count(*)::int from transport_stops s where s.route_id = r.id) as stops,
             ${staffLabel("d")} as driver, ${staffLabel("t")} as attendant
      from transport_routes r left join transport_vehicles v on v.id = r.vehicle_id
      left join staff_profiles d on d.id = r.driver_staff_id left join staff_profiles t on t.id = r.attendant_staff_id
      where r.school_id = ${schoolId}::uuid order by r.archived_at is not null, lower(r.name)`)) as unknown as RouteRow[],
  );
}

export interface RouteDetail {
  id: string;
  name: string;
  vehicleId: string | null;
  vehicle: string | null;
  capacity: number | null;
  driverNo: string | null;
  driver: string | null;
  attendantNo: string | null;
  attendant: string | null;
  archived: boolean;
  stops: { id: string; name: string; sequence: number; pickup: string; drop: string; students: number }[];
  students: { assignmentId: string; studentId: string; name: string; admissionNo: string; sectionLabel: string | null; stopId: string; stop: string; startsOn: string }[];
}

export async function getRoute(db: Db, ctx: RequestContext, schoolId: string, routeId: string): Promise<RouteDetail> {
  parse(uuidField("Route"), routeId);
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const [r] = (await tx.execute(sql`
      select r.id, r.name, r.vehicle_id as "vehicleId", v.registration_no as vehicle, v.capacity, r.archived_at is not null as archived,
             d.employee_no as "driverNo", ${staffLabel("d")} as driver, t.employee_no as "attendantNo", ${staffLabel("t")} as attendant
      from transport_routes r left join transport_vehicles v on v.id = r.vehicle_id
      left join staff_profiles d on d.id = r.driver_staff_id left join staff_profiles t on t.id = r.attendant_staff_id
      where r.school_id = ${schoolId}::uuid and r.id = ${routeId}::uuid`)) as unknown as Omit<RouteDetail, "stops" | "students">[];
    if (!r) throw new AppError("NOT_FOUND", "Route not found.");
    const stops = ((await tx.execute(sql`
      select s.id, s.name, s.sequence, s.pickup_minute as "pickupMinute", s.drop_minute as "dropMinute",
             (select count(*)::int from transport_assignments a where a.stop_id = s.id and a.ended_on is null) as students
      from transport_stops s where s.route_id = ${routeId}::uuid order by s.sequence`)) as unknown as { id: string; name: string; sequence: number; pickupMinute: number | null; dropMinute: number | null; students: number }[]).map(
      (s) => ({ id: s.id, name: s.name, sequence: s.sequence, pickup: formatClock(s.pickupMinute), drop: formatClock(s.dropMinute), students: s.students }),
    );
    const students = (await tx.execute(sql`
      select a.id as "assignmentId", p.id as "studentId", p.display_name as name, p.admission_no as "admissionNo",
             case when sec.id is null then null else c.name || ' ' || sec.name end as "sectionLabel", s.id as "stopId", s.name as stop, a.starts_on::text as "startsOn"
      from transport_assignments a join student_profiles p on p.id = a.student_id join transport_stops s on s.id = a.stop_id
      left join academic_years y on y.school_id = p.school_id and y.status = 'current'
      left join enrollments e on e.student_id = p.id and e.academic_year_id = y.id and e.ends_on is null
      left join sections sec on sec.id = e.section_id left join classes c on c.id = sec.class_id
      where a.route_id = ${routeId}::uuid and a.ended_on is null order by s.sequence, lower(p.display_name)`)) as unknown as RouteDetail["students"];
    return { ...r, stops, students };
  });
}

/* ------------------------------------------------------------------ stops */

interface StopInput {
  name: string;
  sequence: string | number;
  pickup?: string;
  drop?: string;
}

function stopValues(input: StopInput) {
  return {
    name: parse(trimmed("Stop name", 1, 80), input.name),
    sequence: parse(z.coerce.number({ message: "Position: 1 to 99." }).int("Position: 1 to 99.").min(1, "Position: 1 to 99.").max(99, "Position: 1 to 99."), input.sequence),
    pickupMinute: parseClock(input.pickup, "Pickup time"),
    dropMinute: parseClock(input.drop, "Drop time"),
  };
}

export async function addStop(db: Db, ctx: RequestContext, schoolId: string, routeId: string, input: StopInput): Promise<{ id: string }> {
  parse(uuidField("Route"), routeId);
  const v = stopValues(input);
  return guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const [r] = await tx.select({ id: transportRoutes.id }).from(transportRoutes).where(and(eq(transportRoutes.schoolId, schoolId), eq(transportRoutes.id, routeId), isNull(transportRoutes.archivedAt)));
      if (!r) throw new AppError("NOT_FOUND", "Route not found.");
      const [s] = await tx.insert(transportStops).values({ schoolId, routeId, ...v }).returning({ id: transportStops.id });
      await audit(tx, { action: "transport.stop_added", actorUserId: actor.userId, schoolId, entityType: "transport_route", entityId: routeId, data: { stop: v.name } });
      return { id: s!.id };
    }),
  );
}

export async function updateStop(db: Db, ctx: RequestContext, schoolId: string, stopId: string, input: StopInput): Promise<void> {
  parse(uuidField("Stop"), stopId);
  const v = stopValues(input);
  await guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const r = await tx.update(transportStops).set(v).where(and(eq(transportStops.schoolId, schoolId), eq(transportStops.id, stopId))).returning({ routeId: transportStops.routeId });
      if (r.length === 0) throw new AppError("NOT_FOUND", "Stop not found.");
      await audit(tx, { action: "transport.stop_updated", actorUserId: actor.userId, schoolId, entityType: "transport_route", entityId: r[0]!.routeId, data: { stopId } });
    }),
  );
}

/* ------------------------------------------------------------------ assignments */

/**
 * Puts a student (by admission number) on a route at a stop from today. A student already on a
 * route is moved: the old assignment ends today. The database refuses a full route.
 */
export async function assignStudent(db: Db, ctx: RequestContext, schoolId: string, input: { admissionNo: string; routeId: string; stopId: string }): Promise<{ studentName: string; moved: boolean }> {
  parse(uuidField("Route"), input.routeId);
  const stopId = parse(uuidField("Stop"), input.stopId);
  const key = input.admissionNo.trim();
  if (!key) throw new AppError("VALIDATION", "Enter the student's admission number.", { admissionNo: "Required." });
  return guarded(() =>
    withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
      const [p] = (await tx.execute(sql`select id, display_name as name, status::text as status from student_profiles where school_id = ${schoolId}::uuid and lower(admission_no) = lower(${key}) for update`)) as unknown as { id: string; name: string; status: string }[];
      if (!p) throw new AppError("NOT_FOUND", "No student has that admission number.", { admissionNo: "Not found." });
      if (p.status !== "active") throw new AppError("CONFLICT", `${p.name} has left the school.`);
      const [stop] = await tx.select().from(transportStops).where(and(eq(transportStops.schoolId, schoolId), eq(transportStops.id, stopId), eq(transportStops.routeId, input.routeId)));
      if (!stop) throw new AppError("NOT_FOUND", "That stop is not on this route.", { stopId: "Choose a stop." });
      const today = await schoolDay(tx, schoolId);
      const [current] = await tx.select().from(transportAssignments).where(and(eq(transportAssignments.studentId, p.id), isNull(transportAssignments.endedOn)));
      if (current && current.routeId === input.routeId && current.stopId === stopId) throw new AppError("CONFLICT", `${p.name} is already on this route at this stop.`);
      if (current) {
        await tx.update(transportAssignments).set({ endedOn: today < current.startsOn ? current.startsOn : today, endedBy: actor.userId }).where(eq(transportAssignments.id, current.id));
      }
      const [a] = await tx
        .insert(transportAssignments)
        .values({ schoolId, studentId: p.id, routeId: input.routeId, stopId, startsOn: today, createdBy: actor.userId })
        .returning({ id: transportAssignments.id });
      await audit(tx, { action: "transport.student_assigned", actorUserId: actor.userId, schoolId, entityType: "transport_assignment", entityId: a!.id, data: { studentId: p.id, routeId: input.routeId, stopId, previous: current?.id ?? null } });
      return { studentName: p.name, moved: Boolean(current) };
    }),
  );
}

export async function endTransportAssignment(db: Db, ctx: RequestContext, schoolId: string, assignmentId: string): Promise<void> {
  parse(uuidField("Assignment"), assignmentId);
  await withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const [a] = await tx
      .select()
      .from(transportAssignments)
      .where(and(eq(transportAssignments.schoolId, schoolId), eq(transportAssignments.id, assignmentId), isNull(transportAssignments.endedOn)))
      .for("update");
    if (!a) throw new AppError("NOT_FOUND", "This assignment has already ended.");
    const today = await schoolDay(tx, schoolId);
    await tx.update(transportAssignments).set({ endedOn: today < a.startsOn ? a.startsOn : today, endedBy: actor.userId }).where(eq(transportAssignments.id, a.id));
    await audit(tx, { action: "transport.assignment_ended", actorUserId: actor.userId, schoolId, entityType: "transport_assignment", entityId: a.id });
  });
}

/** Students on any route, with search: who is on which route and stop. */
export async function searchAssignments(db: Db, ctx: RequestContext, schoolId: string, search: string): Promise<{ assignmentId: string; routeId: string; route: string; stop: string; name: string; admissionNo: string }[]> {
  const q = search.trim().slice(0, 100);
  if (!q) return [];
  return withCapability(db, ctx, schoolId, CAP, async (tx) =>
    (await tx.execute(sql`
      select a.id as "assignmentId", r.id as "routeId", r.name as route, s.name as stop, p.display_name as name, p.admission_no as "admissionNo"
      from transport_assignments a join student_profiles p on p.id = a.student_id join transport_routes r on r.id = a.route_id join transport_stops s on s.id = a.stop_id
      where a.school_id = ${schoolId}::uuid and a.ended_on is null and (p.display_name ilike ${likePattern(q)} or p.admission_no ilike ${likePattern(q)})
      order by lower(p.display_name) limit 50`)) as unknown as { assignmentId: string; routeId: string; route: string; stop: string; name: string; admissionNo: string }[],
  );
}

/* ------------------------------------------------------------------ student and parent */

export interface MyTransport {
  route: string;
  stop: string;
  pickup: string;
  drop: string;
  vehicle: string | null;
  since: string;
}

async function transportOf(tx: Tx, schoolId: string, studentId: string): Promise<MyTransport | null> {
  const [r] = (await tx.execute(sql`
    select r.name as route, s.name as stop, s.pickup_minute as "pickupMinute", s.drop_minute as "dropMinute", v.registration_no as vehicle, a.starts_on::text as since
    from transport_assignments a join transport_routes r on r.id = a.route_id join transport_stops s on s.id = a.stop_id
    left join transport_vehicles v on v.id = r.vehicle_id
    where a.school_id = ${schoolId}::uuid and a.student_id = ${studentId}::uuid and a.ended_on is null`)) as unknown as {
    route: string;
    stop: string;
    pickupMinute: number | null;
    dropMinute: number | null;
    vehicle: string | null;
    since: string;
  }[];
  return r ? { route: r.route, stop: r.stop, pickup: formatClock(r.pickupMinute), drop: formatClock(r.dropMinute), vehicle: r.vehicle, since: r.since } : null;
}

export async function getMyTransport(db: Db, ctx: RequestContext, schoolId: string): Promise<MyTransport | null> {
  return withCapability(db, ctx, schoolId, "school.transport.view", async (tx) => {
    const [me] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and user_id = app_user_id()`)) as unknown as { id: string }[];
    return me ? transportOf(tx, schoolId, me.id) : null;
  });
}

export async function getChildTransport(db: Db, ctx: RequestContext, schoolId: string, studentId: string): Promise<MyTransport | null> {
  parse(uuidField("Student"), studentId);
  return withCapability(db, ctx, schoolId, "school.children.view", async (tx) => {
    const [c] = (await tx.execute(sql`select id from student_profiles where school_id = ${schoolId}::uuid and id = ${studentId}::uuid and app_is_guardian_of(id)`)) as unknown as { id: string }[];
    if (!c) throw new AppError("NOT_FOUND", "Student not found.");
    return transportOf(tx, schoolId, c.id);
  });
}

/* ------------------------------------------------------------------ reports */

export interface TransportSummary {
  routes: number;
  students: number;
  seats: number;
  fullRoutes: number;
}

export async function getTransportSummary(db: Db, ctx: RequestContext, schoolId: string): Promise<TransportSummary> {
  return withCapability(db, ctx, schoolId, CAP, async (tx) => {
    const [r] = (await tx.execute(sql`
      select count(*)::int as routes, coalesce(sum(o.n), 0)::int as students, coalesce(sum(v.capacity), 0)::int as seats,
             count(*) filter (where v.capacity is not null and o.n >= v.capacity)::int as "fullRoutes"
      from transport_routes r left join transport_vehicles v on v.id = r.vehicle_id
      cross join lateral (select count(*)::int as n from transport_assignments a where a.route_id = r.id and a.ended_on is null) o
      where r.school_id = ${schoolId}::uuid and r.archived_at is null`)) as unknown as TransportSummary[];
    return r ?? { routes: 0, students: 0, seats: 0, fullRoutes: 0 };
  });
}

/** Every student currently on a route (or on one route), by route and stop. Audited. */
export async function exportTransportCsv(db: Db, ctx: RequestContext, schoolId: string, routeId?: string): Promise<string> {
  if (routeId) parse(uuidField("Route"), routeId);
  return withCapability(db, ctx, schoolId, CAP, async (tx, actor) => {
    const rows = (await tx.execute(sql`
      select r.name as route, v.registration_no as vehicle, s.sequence, s.name as stop, s.pickup_minute as "pickupMinute", s.drop_minute as "dropMinute",
             p.admission_no as "admissionNo", p.display_name as name, case when sec.id is null then null else c.name || ' ' || sec.name end as "sectionLabel", a.starts_on::text as "startsOn"
      from transport_assignments a join transport_routes r on r.id = a.route_id join transport_stops s on s.id = a.stop_id join student_profiles p on p.id = a.student_id
      left join transport_vehicles v on v.id = r.vehicle_id
      left join academic_years y on y.school_id = p.school_id and y.status = 'current'
      left join enrollments e on e.student_id = p.id and e.academic_year_id = y.id and e.ends_on is null
      left join sections sec on sec.id = e.section_id left join classes c on c.id = sec.class_id
      where a.school_id = ${schoolId}::uuid and a.ended_on is null ${routeId ? sql`and a.route_id = ${routeId}::uuid` : sql``}
      order by lower(r.name), s.sequence, lower(p.display_name)`)) as unknown as {
      route: string;
      vehicle: string | null;
      sequence: number;
      stop: string;
      pickupMinute: number | null;
      dropMinute: number | null;
      admissionNo: string;
      name: string;
      sectionLabel: string | null;
      startsOn: string;
    }[];
    await audit(tx, { action: "transport.exported", actorUserId: actor.userId, schoolId, entityType: routeId ? "transport_route" : "school", entityId: routeId ?? schoolId, data: { rows: rows.length } });
    return toCsv([
      ["Route", "Vehicle", "Stop no.", "Stop", "Pickup", "Drop", "Admission no.", "Student", "Class", "Since"],
      ...rows.map((r) => [r.route, r.vehicle, r.sequence, r.stop, formatClock(r.pickupMinute), formatClock(r.dropMinute), r.admissionNo, r.name, r.sectionLabel, r.startsOn]),
    ]);
  });
}
