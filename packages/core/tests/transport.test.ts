import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { transportAssignments, transportVehicles, withContext, type RequestContext } from "@examio/db";
import { schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import {
  addStop,
  assignStudent,
  createRoute,
  createVehicle,
  endTransportAssignment,
  exportTransportCsv,
  getChildTransport,
  getMyTransport,
  getRoute,
  getTransportSummary,
  listRoutes,
  listVehicles,
  parseClock,
  searchAssignments,
  setRouteArchived,
  setVehicleArchived,
  updateRoute,
  updateStop,
  updateVehicle,
} from "../src/services/transport/transport";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 13.4: transport. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const message = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e as Error).message);
const dbError = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

describe("transport", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let teacher: RequestContext;
  let s1: RequestContext;
  let parent: RequestContext;
  const id: Record<string, string> = {};
  const today = schoolToday("Asia/Kolkata");

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("tra");
    B = await makeSchool("trb");
    admin = A.ctx(A.adminId);
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@trn.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c = (await createClass(app.db, admin, A.id, { name: "Class 4", sortOrder: 4 })).id;
    const sec = (await createSection(app.db, admin, A.id, { yearId, classId: c, name: "B" })).id;
    teacher = A.ctx((await createStaffMember(app.db, admin, A.id, { fullName: "Driver One", email: `d-${randomUUID().slice(0, 6)}@trn.test`, employeeNo: "D-1", role: "teacher" })).userId);
    await createStaffMember(app.db, admin, A.id, { fullName: "Attendant One", email: `t-${randomUUID().slice(0, 6)}@trn.test`, employeeNo: "AT-1", role: "teacher" });
    for (const [k, name] of [["S-1", "Asha"], ["S-2", "Bilal"], ["S-3", "Chitra"]] as const) {
      const r = await admitStudent(app.db, admin, A.id, { fullName: name, admissionNo: k, sectionId: sec });
      id[k] = r.studentId;
      if (k === "S-1") s1 = A.ctx(r.userId);
    }
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, id["S-1"]!, { fullName: "Parent Asha", phone: "9876500071", relationship: "father" })).userId);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("vehicles, routes and stops: validation, unique names, crew from active staff", async () => {
    expect(parseClock("7:05", "Pickup time")).toBe(425);
    expect(() => parseClock("25:00", "Pickup time")).toThrow(/like 07:35/);
    expect(await outcome(createVehicle(app.db, teacher, A.id, { registrationNo: "KA01 AB 1234", capacity: "2" }))).toBe("FORBIDDEN");
    expect(await outcome(createVehicle(app.db, admin, A.id, { registrationNo: "KA01 AB 1234", capacity: "0" }))).toBe("VALIDATION");
    id.van = (await createVehicle(app.db, admin, A.id, { registrationNo: "ka01 ab 1234", capacity: "2", description: "Van" })).id;
    id.bus = (await createVehicle(app.db, admin, A.id, { registrationNo: "KA01-CD-9", capacity: "40" })).id;
    expect(await outcome(createVehicle(app.db, admin, A.id, { registrationNo: "KA01 AB 1234", capacity: "5" }))).toBe("CONFLICT");
    expect((await listVehicles(app.db, admin, A.id)).map((v) => v.registrationNo).sort()).toEqual(["KA01 AB 1234", "KA01-CD-9"]);

    expect(await message(createRoute(app.db, admin, A.id, { name: "North", driver: "D-1", attendant: "d-1" }))).toMatch(/different people/);
    expect(await outcome(createRoute(app.db, admin, A.id, { name: "North", driver: "X-1" }))).toBe("NOT_FOUND");
    id.north = (await createRoute(app.db, admin, A.id, { name: "North", vehicleId: id.van, driver: "D-1", attendant: "AT-1" })).id;
    id.south = (await createRoute(app.db, admin, A.id, { name: "South" })).id;
    expect(await outcome(createRoute(app.db, admin, A.id, { name: "north" }))).toBe("CONFLICT");

    id.n1 = (await addStop(app.db, admin, A.id, id.north, { name: "Temple", sequence: "1", pickup: "07:10", drop: "15:40" })).id;
    id.n2 = (await addStop(app.db, admin, A.id, id.north, { name: "Market", sequence: "2", pickup: "07:20" })).id;
    expect(await outcome(addStop(app.db, admin, A.id, id.north, { name: "Park", sequence: "2" }))).toBe("CONFLICT");
    expect(await outcome(addStop(app.db, admin, A.id, id.north, { name: "temple", sequence: "3" }))).toBe("CONFLICT");
    id.s1stop = (await addStop(app.db, admin, A.id, id.south, { name: "Lake", sequence: "1" })).id;
    await updateStop(app.db, admin, A.id, id.n2, { name: "Main market", sequence: "2", pickup: "07:25", drop: "" });
    const r = await getRoute(app.db, admin, A.id, id.north);
    expect(r).toMatchObject({ vehicle: "KA01 AB 1234", capacity: 2, driver: "Driver One (D-1)", attendant: "Attendant One (AT-1)" });
    expect(r.stops.map((s) => [s.sequence, s.name, s.pickup, s.drop])).toEqual([[1, "Temple", "07:10", "15:40"], [2, "Main market", "07:25", ""]]);
  });

  it("capacity is never exceeded, also when two desks assign the last seat at once", async () => {
    expect(await message(assignStudent(app.db, admin, A.id, { admissionNo: "S-1", routeId: id.south!, stopId: id.s1stop! }))).toMatch(/vehicle first/);
    expect(await outcome(assignStudent(app.db, admin, A.id, { admissionNo: "S-1", routeId: id.south!, stopId: id.n1! }))).toBe("NOT_FOUND"); // stop of another route
    expect(await assignStudent(app.db, admin, A.id, { admissionNo: "s-1", routeId: id.north!, stopId: id.n1! })).toEqual({ studentName: "Asha", moved: false });
    expect(await message(assignStudent(app.db, admin, A.id, { admissionNo: "S-1", routeId: id.north!, stopId: id.n1! }))).toMatch(/already on this route/);
    const race = await Promise.allSettled([
      assignStudent(app.db, admin, A.id, { admissionNo: "S-2", routeId: id.north!, stopId: id.n2! }),
      assignStudent(app.db, admin2, A.id, { admissionNo: "S-3", routeId: id.north!, stopId: id.n2! }),
    ]);
    expect(race.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = race.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as AppError).message).toMatch(/more students on the route than the vehicle has seats/);
    expect((await listRoutes(app.db, admin, A.id)).find((r) => r.name === "North")).toMatchObject({ occupancy: 2, capacity: 2, stops: 2 });

    // Capacity changes that would not fit are refused, by the service and the database.
    expect(await message(updateVehicle(app.db, admin, A.id, id.van!, { capacity: "1" }))).toMatch(/more students/);
    expect(await dbError(withContext(app.db, admin, (tx) => tx.update(transportVehicles).set({ capacity: 1 }).where(sql`id = ${id.van}::uuid`)))).toMatch(/route using this vehicle/);
    expect(await message(setVehicleArchived(app.db, admin, A.id, id.van!, true))).toMatch(/still uses/);
    expect(await message(updateRoute(app.db, admin, A.id, id.north!, { name: "North" }))).toMatch(/more students/); // removing the vehicle
    expect(await message(setRouteArchived(app.db, admin, A.id, id.north!, true))).toMatch(/still on this route/);
    // A bigger vehicle makes room.
    await updateRoute(app.db, admin, A.id, id.north!, { name: "North", vehicleId: id.bus, driver: "D-1", attendant: "AT-1" });
    await updateVehicle(app.db, admin, A.id, id.van!, { capacity: "1" });
    const third = ["S-2", "S-3"].find((k) => !race.some((x, i) => x.status === "fulfilled" && ["S-2", "S-3"][i] === k))!;
    await assignStudent(app.db, admin, A.id, { admissionNo: third, routeId: id.north!, stopId: id.n2! });
    expect((await getRoute(app.db, admin, A.id, id.north!)).students.map((s) => [s.stop, s.sectionLabel])).toEqual([["Temple", "Class 4 B"], ["Main market", "Class 4 B"], ["Main market", "Class 4 B"]]);
  });

  it("moving a student ends the old assignment and keeps history; ending frees the seat", async () => {
    await updateRoute(app.db, admin, A.id, id.south!, { name: "South", vehicleId: id.van });
    expect(await assignStudent(app.db, admin, A.id, { admissionNo: "S-1", routeId: id.south!, stopId: id.s1stop! })).toEqual({ studentName: "Asha", moved: true });
    const rows = await owner.db.select().from(transportAssignments).where(sql`student_id = ${id["S-1"]}::uuid`).orderBy(transportAssignments.createdAt);
    expect(rows.map((r) => [r.routeId === id.south, r.endedOn])).toEqual([[false, today], [true, null]]);
    expect(await message(assignStudent(app.db, admin, A.id, { admissionNo: "S-2", routeId: id.south!, stopId: id.s1stop! }))).toMatch(/more students/); // the van has 1 seat now
    const found = await searchAssignments(app.db, admin, A.id, "asha");
    expect(found.map((f) => [f.route, f.stop])).toEqual([["South", "Lake"]]);
    await endTransportAssignment(app.db, admin, A.id, found[0]!.assignmentId);
    expect(await outcome(endTransportAssignment(app.db, admin, A.id, found[0]!.assignmentId))).toBe("NOT_FOUND");
    await assignStudent(app.db, admin, A.id, { admissionNo: "S-1", routeId: id.south!, stopId: id.s1stop! });
    // Ended assignments cannot be changed or reopened, even directly.
    expect(await withContext(app.db, admin, (tx) => tx.update(transportAssignments).set({ endedOn: null, endedBy: null }).where(sql`ended_on is not null`).returning())).toHaveLength(0);
    expect(await getTransportSummary(app.db, admin, A.id)).toEqual({ routes: 2, students: 3, seats: 41, fullRoutes: 1 });
    const csv = await exportTransportCsv(app.db, admin, A.id);
    expect(csv.split("\r\n")[0]).toBe("Route,Vehicle,Stop no.,Stop,Pickup,Drop,Admission no.,Student,Class,Since");
    expect(csv).toContain("South,KA01 AB 1234,1,Lake,,,S-1,Asha,Class 4 B");
  });

  it("students and parents see only their own route; teachers and other schools see no assignments", async () => {
    expect(await getMyTransport(app.db, s1, A.id)).toMatchObject({ route: "South", stop: "Lake", vehicle: "KA01 AB 1234", since: today });
    expect(await getChildTransport(app.db, parent, A.id, id["S-1"]!)).toMatchObject({ route: "South" });
    expect(await outcome(getChildTransport(app.db, parent, A.id, id["S-2"]!))).toBe("NOT_FOUND");
    const own = await withContext(app.db, s1, (tx) => tx.select().from(transportAssignments));
    expect(own.map((a) => a.studentId === id["S-1"])).toEqual([true, true, true]); // history included, nobody else's
    expect(await withContext(app.db, teacher, (tx) => tx.select().from(transportAssignments))).toHaveLength(0);
    expect(await outcome(listRoutes(app.db, teacher, A.id))).toBe("FORBIDDEN");
    expect(await dbError(withContext(app.db, s1, (tx) => tx.insert(transportAssignments).values({ schoolId: A.id, studentId: id["S-1"]!, routeId: id.north!, stopId: id.n1!, startsOn: today, createdBy: String(s1.userId) })))).toMatch(/row-level security/);
    const other = B.ctx(B.adminId);
    expect(await withContext(app.db, other, (tx) => tx.select().from(transportAssignments))).toHaveLength(0);
    expect(await outcome(getRoute(app.db, other, B.id, id.north!))).toBe("NOT_FOUND");
    expect(await outcome(updateRoute(app.db, other, B.id, id.north!, { name: "Taken" }))).toBe("NOT_FOUND");
    const bRoute = (await createRoute(app.db, other, B.id, { name: "B route" })).id;
    expect(await outcome(updateRoute(app.db, other, B.id, bRoute, { name: "B route", vehicleId: id.bus }))).toBe("NOT_FOUND");
  });
});
