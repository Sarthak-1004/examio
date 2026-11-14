import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { academicYears, auditEvents, classSubjects, classes, schools, sections, withContext, type RequestContext } from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { addCalendarEntry, createAttendanceSession, deleteCalendarEntry, listAttendanceSessions, listCalendar, setAttendanceSessionArchived } from "../src/services/setup/calendar";
import { getSetupChecklist } from "../src/services/setup/checklist";
import { bpToPercent, percentToBp } from "../src/services/setup/common";
import {
  CBSE_STYLE_PRESET,
  createGradingScheme,
  gradeFor,
  listGradingSchemes,
  passes,
  setDefaultGradingScheme,
  setGradingSchemeArchived,
  updateGradingScheme,
} from "../src/services/setup/grading";
import { getSchoolProfile, updateSchoolProfile } from "../src/services/setup/profile";
import {
  addStandardClasses,
  createClass,
  createSection,
  createSubject,
  deleteSetupItem,
  listClassSubjects,
  listClasses,
  listSections,
  listSubjects,
  renameSubject,
  setArchived,
  setClassSubjects,
  updateClass,
  updateSection,
} from "../src/services/setup/structure";
import {
  copyYearStructure,
  createAcademicYear,
  deleteAcademicYear,
  getCurrentAcademicYear,
  listAcademicYears,
  setAcademicYearStatus,
  updateAcademicYear,
} from "../src/services/setup/years";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 3: school and academic setup. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

describe("school and academic setup", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("sta");
    B = await makeSchool("stb");
    admin = A.ctx(A.adminId);
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  describe("academic years", () => {
    it("creates years, refuses duplicates and bad dates, and warns about overlaps", async () => {
      const first = await createAcademicYear(app.db, admin, A.id, { name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" });
      expect(first.overlapsWith).toEqual([]);
      expect(await outcome(createAcademicYear(app.db, admin, A.id, { name: " 2026-27 ", startsOn: "2027-04-01", endsOn: "2028-03-31" }))).toBe("CONFLICT");
      for (const bad of [
        { name: "Bad", startsOn: "2026-04-01", endsOn: "2026-04-01" },
        { name: "Bad", startsOn: "2026-02-30", endsOn: "2027-01-01" },
        { name: "Bad", startsOn: "2026-01-01", endsOn: "2029-01-01" },
        { name: "", startsOn: "2026-01-01", endsOn: "2026-12-31" },
      ]) {
        expect(await outcome(createAcademicYear(app.db, admin, A.id, bad))).toBe("VALIDATION");
      }
      const next = await createAcademicYear(app.db, admin, A.id, { name: "2027-28", startsOn: "2027-03-15", endsOn: "2028-03-31" });
      expect(next.overlapsWith).toEqual(["2026-27"]);
    });

    it("keeps one current year: making a year current closes the previous one", async () => {
      const [y26, y27] = (await listAcademicYears(app.db, admin, A.id)).sort((a, b) => a.startsOn.localeCompare(b.startsOn));
      await setAcademicYearStatus(app.db, admin, A.id, y26!.id, "current");
      expect((await getCurrentAcademicYear(app.db, admin, A.id))?.name).toBe("2026-27");
      await setAcademicYearStatus(app.db, admin, A.id, y27!.id, "current");
      const years = await listAcademicYears(app.db, admin, A.id);
      expect(Object.fromEntries(years.map((y) => [y.name, y.status]))).toEqual({ "2026-27": "closed", "2027-28": "current" });
      expect(await outcome(setAcademicYearStatus(app.db, admin, A.id, y27!.id, "planned"))).toBe("CONFLICT");

      // A closed year is read-only until reopened.
      expect(await outcome(updateAcademicYear(app.db, admin, A.id, y26!.id, { name: "2026-27 (edited)", startsOn: "2026-04-01", endsOn: "2027-03-31" }))).toBe("CONFLICT");
      await setAcademicYearStatus(app.db, admin, A.id, y26!.id, "planned");
      expect(await outcome(updateAcademicYear(app.db, admin, A.id, y26!.id, { name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-30" }))).toBe("OK");
      await setAcademicYearStatus(app.db, admin, A.id, y26!.id, "closed");

      const audits = await owner.db.select().from(auditEvents).where(and(eq(auditEvents.schoolId, A.id), eq(auditEvents.entityId, y26!.id)));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["setup.year.created", "setup.year.made_current", "setup.year.closed", "setup.year.reopened"]));
    });

    it("the database allows only one current year per school", async () => {
      const err = await failure(owner.db.update(academicYears).set({ status: "current" }).where(eq(academicYears.schoolId, A.id)));
      expect(err).not.toBeNull();
    });

    it("deletes an empty year but not the current year or one with content", async () => {
      const spare = await createAcademicYear(app.db, admin, A.id, { name: "Spare", startsOn: "2030-01-01", endsOn: "2030-12-31" });
      expect(await outcome(deleteAcademicYear(app.db, admin, A.id, spare.id))).toBe("OK");
      const current = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      expect(await outcome(deleteAcademicYear(app.db, admin, A.id, current.id))).toBe("CONFLICT");
    });
  });

  describe("classes, sections and subjects", () => {
    it("adds Class 1 to 12 once, and refuses duplicate names regardless of case", async () => {
      expect((await addStandardClasses(app.db, admin, A.id)).added).toBe(12);
      expect((await addStandardClasses(app.db, admin, A.id)).added).toBe(0);
      expect(await outcome(createClass(app.db, admin, A.id, { name: "class 5" }))).toBe("CONFLICT");
      const nursery = await createClass(app.db, admin, A.id, { name: "Nursery", sortOrder: -2 });
      const list = await listClasses(app.db, admin, A.id);
      expect(list[0]!.name).toBe("Nursery");
      expect(list.map((c) => c.name)).toContain("Class 12");
      await updateClass(app.db, admin, A.id, nursery.id, { name: "Pre-Nursery", sortOrder: -3 });
      expect(await outcome(updateClass(app.db, admin, A.id, nursery.id, { name: "Class 1" }))).toBe("CONFLICT");
    });

    it("creates sections per year and class with valid capacities", async () => {
      const year = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const c1 = (await listClasses(app.db, admin, A.id)).find((c) => c.name === "Class 1")!;
      const s = await createSection(app.db, admin, A.id, { yearId: year.id, classId: c1.id, name: "A", capacity: "40" });
      await createSection(app.db, admin, A.id, { yearId: year.id, classId: c1.id, name: "B", capacity: "" });
      expect(await outcome(createSection(app.db, admin, A.id, { yearId: year.id, classId: c1.id, name: "a" }))).toBe("CONFLICT");
      for (const capacity of ["0", "501", "12.5", "lots"]) {
        expect(await outcome(createSection(app.db, admin, A.id, { yearId: year.id, classId: c1.id, name: "Z", capacity }))).toBe("VALIDATION");
      }
      await updateSection(app.db, admin, A.id, s.id, { name: "A", capacity: 45 });
      const list = await listSections(app.db, admin, A.id, year.id);
      expect(list.map((x) => [x.name, x.capacity])).toEqual([["A", 45], ["B", null]]);
    });

    it("refuses sections in a closed year or for an archived class", async () => {
      const closed = (await listAcademicYears(app.db, admin, A.id)).find((y) => y.status === "closed")!;
      const current = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const c2 = (await listClasses(app.db, admin, A.id)).find((c) => c.name === "Class 2")!;
      expect(await outcome(createSection(app.db, admin, A.id, { yearId: closed.id, classId: c2.id, name: "A" }))).toBe("CONFLICT");
      // The database refuses it too, even when the service check is skipped.
      const direct = await failure(withContext(app.db, admin, (tx) => tx.insert(sections).values({ schoolId: A.id, academicYearId: closed.id, classId: c2.id, name: "X" })));
      expect(isRlsViolation(direct)).toBe(true);

      await setArchived(app.db, admin, A.id, "class", c2.id, true);
      expect(await outcome(createSection(app.db, admin, A.id, { yearId: current.id, classId: c2.id, name: "A" }))).toBe("CONFLICT");
      expect((await listClasses(app.db, admin, A.id)).some((c) => c.id === c2.id)).toBe(false);
      expect((await listClasses(app.db, admin, A.id, { includeArchived: true })).find((c) => c.id === c2.id)?.archived).toBe(true);
      await setArchived(app.db, admin, A.id, "class", c2.id, false);
    });

    it("normalises subject codes, refuses duplicates and keeps codes fixed", async () => {
      const math = await createSubject(app.db, admin, A.id, { name: "Mathematics", code: "math" });
      await createSubject(app.db, admin, A.id, { name: "Science", code: "SCI" });
      await createSubject(app.db, admin, A.id, { name: "English", code: "ENG" });
      expect((await listSubjects(app.db, admin, A.id)).find((s) => s.id === math.id)?.code).toBe("MATH");
      expect(await outcome(createSubject(app.db, admin, A.id, { name: "Maths 2", code: "MATH" }))).toBe("CONFLICT");
      expect(await outcome(createSubject(app.db, admin, A.id, { name: "mathematics", code: "MTH" }))).toBe("CONFLICT");
      for (const code of ["M", "-ABC", "MATH SCI", "A".repeat(13)]) {
        expect(await outcome(createSubject(app.db, admin, A.id, { name: `Subject ${code}`, code }))).toBe("VALIDATION");
      }
      await renameSubject(app.db, admin, A.id, math.id, "Maths");
      expect((await listSubjects(app.db, admin, A.id)).find((s) => s.id === math.id)).toMatchObject({ name: "Maths", code: "MATH" });
    });

    it("sets exactly the subjects a class studies, only from this school's active subjects", async () => {
      const year = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const c1 = (await listClasses(app.db, admin, A.id)).find((c) => c.name === "Class 1")!;
      const subs = await listSubjects(app.db, admin, A.id);
      const ids = subs.map((s) => s.id);
      expect(await setClassSubjects(app.db, admin, A.id, { yearId: year.id, classId: c1.id, subjectIds: ids })).toEqual({ added: 3, removed: 0 });
      expect(await setClassSubjects(app.db, admin, A.id, { yearId: year.id, classId: c1.id, subjectIds: [ids[0]!, ids[0]!] })).toEqual({ added: 0, removed: 2 });
      expect((await listClassSubjects(app.db, admin, A.id, year.id))[0]).toEqual({ classId: c1.id, subjectIds: [ids[0]] });

      const foreign = await createSubject(app.db, B.ctx(B.adminId), B.id, { name: "History", code: "HIS" });
      expect(await outcome(setClassSubjects(app.db, admin, A.id, { yearId: year.id, classId: c1.id, subjectIds: [foreign.id] }))).toBe("NOT_FOUND");
      const archived = await createSubject(app.db, admin, A.id, { name: "Old Subject", code: "OLD" });
      await setArchived(app.db, admin, A.id, "subject", archived.id, true);
      expect(await outcome(setClassSubjects(app.db, admin, A.id, { yearId: year.id, classId: c1.id, subjectIds: [archived.id] }))).toBe("NOT_FOUND");
      await setClassSubjects(app.db, admin, A.id, { yearId: year.id, classId: c1.id, subjectIds: ids });
    });

    it("deletes only unused items; anything in use must be archived", async () => {
      const c1 = (await listClasses(app.db, admin, A.id)).find((c) => c.name === "Class 1")!;
      const math = (await listSubjects(app.db, admin, A.id)).find((s) => s.code === "MATH")!;
      expect(await outcome(deleteSetupItem(app.db, admin, A.id, "class", c1.id))).toBe("CONFLICT");
      expect(await outcome(deleteSetupItem(app.db, admin, A.id, "subject", math.id))).toBe("CONFLICT");
      const unused = await createClass(app.db, admin, A.id, { name: "Temporary" });
      expect(await outcome(deleteSetupItem(app.db, admin, A.id, "class", unused.id))).toBe("OK");
      expect(await owner.db.select().from(classes).where(eq(classes.id, unused.id))).toHaveLength(0);
    });

    it("composite keys stop setup from pointing at another school's records", async () => {
      const yearA = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const bClass = await createClass(app.db, B.ctx(B.adminId), B.id, { name: "Class 1" });
      const crossed = await failure(owner.db.insert(sections).values({ schoolId: A.id, academicYearId: yearA.id, classId: bClass.id, name: "X" }));
      expect(crossed).not.toBeNull();
      const crossedMap = await failure(owner.db.insert(classSubjects).values({ schoolId: B.id, academicYearId: yearA.id, classId: bClass.id, subjectId: bClass.id }));
      expect(crossedMap).not.toBeNull();
    });

    it("copies a year's sections and subjects into an empty year", async () => {
      const from = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const to = await createAcademicYear(app.db, admin, A.id, { name: "2028-29", startsOn: "2028-04-01", endsOn: "2029-03-31" });
      const result = await copyYearStructure(app.db, admin, A.id, from.id, to.id);
      expect(result).toEqual({ sections: 2, classSubjects: 3 });
      expect((await listSections(app.db, admin, A.id, to.id)).map((s) => s.name)).toEqual(["A", "B"]);
      expect(await outcome(copyYearStructure(app.db, admin, A.id, from.id, to.id))).toBe("CONFLICT");
      expect(await outcome(copyYearStructure(app.db, admin, A.id, from.id, from.id))).toBe("VALIDATION");
    });
  });

  describe("grading", () => {
    it("converts percentages exactly", () => {
      expect(percentToBp("33")).toBe(3300);
      expect(percentToBp("33.5")).toBe(3350);
      expect(percentToBp("33.33")).toBe(3333);
      expect(percentToBp("100")).toBe(10000);
      for (const bad of ["100.01", "-1", "33.333", "abc", ""]) expect(percentToBp(bad)).toBeNull();
      expect(bpToPercent(3300)).toBe("33");
      expect(bpToPercent(3350)).toBe("33.5");
      expect(bpToPercent(3333)).toBe("33.33");
    });

    it("maps every percentage to exactly one grade, at exact boundaries", async () => {
      const { id } = await createGradingScheme(app.db, admin, A.id, CBSE_STYLE_PRESET);
      const scheme = (await listGradingSchemes(app.db, admin, A.id)).find((s) => s.id === id)!;
      expect(scheme).toMatchObject({ isDefault: true, passBp: 3300 });
      const g = (bp: number) => gradeFor(scheme.bands, bp).label;
      expect([g(10000), g(9100), g(9099), g(8100), g(3300), g(3299), g(0)]).toEqual(["A1", "A1", "A2", "A2", "D", "E", "E"]);
      expect(passes(scheme, 3300)).toBe(true);
      expect(passes(scheme, 3299)).toBe(false);
      expect(() => gradeFor(scheme.bands, 10001)).toThrow();
    });

    it("rejects schemes that would leave marks without a grade or with two", async () => {
      const bad = [
        { name: "No zero", passPercent: "40", bands: [{ label: "A", minPercent: "50" }, { label: "B", minPercent: "10" }] },
        { name: "Same min", passPercent: "40", bands: [{ label: "A", minPercent: "50" }, { label: "B", minPercent: "50" }, { label: "C", minPercent: "0" }] },
        { name: "Same label", passPercent: "40", bands: [{ label: "A", minPercent: "50" }, { label: "a", minPercent: "0" }] },
        { name: "Bad pass", passPercent: "120", bands: [{ label: "A", minPercent: "50" }, { label: "B", minPercent: "0" }] },
        { name: "One band", passPercent: "40", bands: [{ label: "A", minPercent: "0" }] },
      ];
      for (const s of bad) expect([s.name, await outcome(createGradingScheme(app.db, admin, A.id, s))]).toEqual([s.name, "VALIDATION"]);
      expect(await outcome(createGradingScheme(app.db, admin, A.id, { ...CBSE_STYLE_PRESET, name: "cbse-style (a1–e)" }))).toBe("CONFLICT");
    });

    it("changes the default, protects it from archiving, and replaces bands atomically", async () => {
      const simple = await createGradingScheme(app.db, admin, A.id, { name: "Pass/Fail", passPercent: "40", bands: [{ label: "P", minPercent: "40" }, { label: "F", minPercent: "0" }] });
      const before = await listGradingSchemes(app.db, admin, A.id);
      const cbse = before.find((s) => s.isDefault)!;
      expect(before.find((s) => s.id === simple.id)?.isDefault).toBe(false);
      expect(await outcome(setGradingSchemeArchived(app.db, admin, A.id, cbse.id, true))).toBe("CONFLICT");
      await setDefaultGradingScheme(app.db, admin, A.id, simple.id);
      expect(await outcome(setGradingSchemeArchived(app.db, admin, A.id, cbse.id, true))).toBe("OK");
      expect(await outcome(setDefaultGradingScheme(app.db, admin, A.id, cbse.id))).toBe("CONFLICT");
      await setGradingSchemeArchived(app.db, admin, A.id, cbse.id, false);

      await updateGradingScheme(app.db, admin, A.id, simple.id, { name: "Pass/Fail", passPercent: "35", bands: [{ label: "P", minPercent: "35" }, { label: "F", minPercent: "0" }] });
      const updated = (await listGradingSchemes(app.db, admin, A.id)).find((s) => s.id === simple.id)!;
      expect(updated.passBp).toBe(3500);
      expect(updated.bands.map((b) => [b.label, b.minBp])).toEqual([["P", 3500], ["F", 0]]);
      // An invalid update changes nothing.
      expect(await outcome(updateGradingScheme(app.db, admin, A.id, simple.id, { name: "Pass/Fail", passPercent: "35", bands: [{ label: "P", minPercent: "35" }] }))).toBe("VALIDATION");
      expect((await listGradingSchemes(app.db, admin, A.id)).find((s) => s.id === simple.id)!.bands).toHaveLength(2);
    });
  });

  describe("calendar and attendance sessions", () => {
    it("adds entries within the year only, and not to a closed year", async () => {
      const year = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const { id } = await addCalendarEntry(app.db, admin, A.id, year.id, { title: "Diwali break", kind: "holiday", startsOn: "2027-10-28", endsOn: "2027-11-02" });
      expect(await outcome(addCalendarEntry(app.db, admin, A.id, year.id, { title: "Too early", kind: "event", startsOn: "2020-01-01", endsOn: "2020-01-01" }))).toBe("VALIDATION");
      expect(await outcome(addCalendarEntry(app.db, admin, A.id, year.id, { title: "Backwards", kind: "event", startsOn: "2027-12-05", endsOn: "2027-12-01" }))).toBe("VALIDATION");
      expect(await outcome(addCalendarEntry(app.db, admin, A.id, year.id, { title: "Bad kind", kind: "party" as "event", startsOn: "2027-12-05", endsOn: "2027-12-05" }))).toBe("VALIDATION");
      const closed = (await listAcademicYears(app.db, admin, A.id)).find((y) => y.status === "closed")!;
      expect(await outcome(addCalendarEntry(app.db, admin, A.id, closed.id, { title: "Late", kind: "holiday", startsOn: "2026-05-01", endsOn: "2026-05-01" }))).toBe("CONFLICT");
      expect((await listCalendar(app.db, admin, A.id, year.id)).map((e) => e.title)).toEqual(["Diwali break"]);
      await deleteCalendarEntry(app.db, admin, A.id, id);
      expect(await listCalendar(app.db, admin, A.id, year.id)).toEqual([]);
      await addCalendarEntry(app.db, admin, A.id, year.id, { title: "Republic Day", kind: "holiday", startsOn: "2028-01-26", endsOn: "2028-01-26" });
    });

    it("every school starts with a Full day session and always keeps one", async () => {
      const sessions = await listAttendanceSessions(app.db, admin, A.id);
      expect(sessions.map((s) => s.name)).toEqual(["Full day"]);
      expect(await outcome(setAttendanceSessionArchived(app.db, admin, A.id, sessions[0]!.id, true))).toBe("CONFLICT");
      const afternoon = await createAttendanceSession(app.db, admin, A.id, { name: "Afternoon", sortOrder: 2 });
      expect(await outcome(createAttendanceSession(app.db, admin, A.id, { name: "afternoon" }))).toBe("CONFLICT");
      await setAttendanceSessionArchived(app.db, admin, A.id, afternoon.id, true);
      expect((await listAttendanceSessions(app.db, admin, A.id)).map((s) => s.name)).toEqual(["Full day"]);
    });
  });

  describe("school profile", () => {
    it("school admins edit the profile; values are validated", async () => {
      await updateSchoolProfile(app.db, admin, A.id, { name: "School STA", shortName: "STA", address: "1 MG Road", contactEmail: "Office@STA.test", contactPhone: "+91 98765 43210", timezone: "Asia/Kolkata", brandColor: "#2953E0" });
      expect(await getSchoolProfile(app.db, admin, A.id)).toMatchObject({ shortName: "STA", contactEmail: "office@sta.test", contactPhone: "9876543210", brandColor: "#2953e0" });
      for (const bad of [{ timezone: "Mars/Olympus" }, { brandColor: "blue" }, { contactEmail: "nope" }, { name: "X" }]) {
        expect(await outcome(updateSchoolProfile(app.db, admin, A.id, { name: "School STA", timezone: "Asia/Kolkata", ...bad }))).toBe("VALIDATION");
      }
      // Board, medium and status stay platform decisions.
      const forged = await failure(withContext(app.db, admin, (tx) => tx.update(schools).set({ status: "suspended" }).where(eq(schools.id, A.id))));
      expect(isRlsViolation(forged)).toBe(true);
    });
  });

  describe("access", () => {
    it("teachers and students can read setup but not change it", async () => {
      for (const actor of [A.teacherId, A.studentId]) {
        const ctx = A.ctx(actor);
        expect((await listClasses(app.db, ctx, A.id)).length).toBeGreaterThan(0);
        expect(await outcome(createClass(app.db, ctx, A.id, { name: "Hack" }))).toBe("FORBIDDEN");
        expect(await outcome(updateSchoolProfile(app.db, ctx, A.id, { name: "Hacked", timezone: "UTC" }))).toBe("FORBIDDEN");
        expect(await outcome(createGradingScheme(app.db, ctx, A.id, CBSE_STYLE_PRESET))).toBe("FORBIDDEN");
        const direct = await failure(withContext(app.db, ctx, (tx) => tx.insert(classes).values({ schoolId: A.id, name: "Direct" })));
        expect(isRlsViolation(direct)).toBe(true);
      }
    });

    it("another school sees and changes nothing", async () => {
      const other = B.ctx(B.adminId);
      expect(await outcome(listClasses(app.db, other, A.id))).toBe("NOT_FOUND");
      expect(await outcome(createClass(app.db, other, A.id, { name: "Hack" }))).toBe("NOT_FOUND");
      const c1 = (await listClasses(app.db, admin, A.id))[1]!;
      expect(await outcome(updateClass(app.db, other, B.id, c1.id, { name: "Hacked" }))).toBe("NOT_FOUND");
      expect(await outcome(deleteSetupItem(app.db, other, B.id, "class", c1.id))).toBe("NOT_FOUND");
      const seen = await withContext(app.db, other, (tx) => tx.select({ id: classes.id }).from(classes).where(eq(classes.schoolId, A.id)));
      expect(seen).toHaveLength(0);
      const platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
      expect(await outcome(listClasses(app.db, platform, A.id))).toBe("FORBIDDEN");
    });
  });

  describe("setup checklist", () => {
    it("shows what is missing for a new school and is ready once everything is set", async () => {
      const fresh = await getSetupChecklist(app.db, B.ctx(B.adminId), B.id);
      expect(fresh.ready).toBe(false);
      expect(Object.fromEntries(fresh.items.map((i) => [i.key, i.done]))).toMatchObject({ profile: false, year: false, classes: true, sections: false, grading: false, sessions: true });

      // School A: make every active class complete for the current year.
      const year = (await getCurrentAcademicYear(app.db, admin, A.id))!;
      const subs = (await listSubjects(app.db, admin, A.id)).map((s) => s.id);
      const existing = new Set((await listSections(app.db, admin, A.id, year.id)).map((s) => s.classId));
      for (const c of await listClasses(app.db, admin, A.id)) {
        if (!existing.has(c.id)) await createSection(app.db, admin, A.id, { yearId: year.id, classId: c.id, name: "A" });
        await setClassSubjects(app.db, admin, A.id, { yearId: year.id, classId: c.id, subjectIds: subs });
      }
      const done = await getSetupChecklist(app.db, admin, A.id);
      expect(done.items.filter((i) => !i.done).map((i) => i.key)).toEqual([]);
      expect(done.ready).toBe(true);
      expect(done.currentYear?.id).toBe(year.id);
      expect(await outcome(getSetupChecklist(app.db, B.ctx(B.adminId), A.id))).toBe("NOT_FOUND");
    });
  });
});
