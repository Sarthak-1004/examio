"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AppError,
  addStop,
  assignStudent,
  createRoute,
  createVehicle,
  endTransportAssignment,
  setRouteArchived,
  setVehicleArchived,
  updateRoute,
  updateStop,
  updateVehicle,
} from "@examio/core";
import type { RequestContext } from "@examio/db";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { str, type FormState } from "@/lib/forms";

/** Transport actions for school administrators; the services and the database check the rest. */
async function act(fn: (ctx: RequestContext, schoolId: string) => Promise<string>): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  try {
    const message = await fn(s.ctx, s.ctx.schoolId);
    revalidatePath("/school/transport", "layout");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
}

const routeFields = (fd: FormData) => ({ name: str(fd, "name"), vehicleId: str(fd, "vehicleId") || undefined, driver: str(fd, "driver"), attendant: str(fd, "attendant") });
const stopFields = (fd: FormData) => ({ name: str(fd, "name"), sequence: str(fd, "sequence"), pickup: str(fd, "pickup"), drop: str(fd, "drop") });

export async function createVehicleAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await createVehicle(db, ctx, schoolId, { registrationNo: str(fd, "registrationNo"), capacity: str(fd, "capacity"), description: str(fd, "description") });
    return "Vehicle added.";
  });
}

export async function updateVehicleAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateVehicle(db, ctx, schoolId, str(fd, "vehicleId"), { capacity: str(fd, "capacity"), description: str(fd, "description") });
    return "Saved.";
  });
}

export async function archiveVehicleAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "1";
    await setVehicleArchived(db, ctx, schoolId, str(fd, "vehicleId"), archived);
    return archived ? "Vehicle archived." : "Vehicle restored.";
  });
}

export async function createRouteAction(_p: FormState, fd: FormData): Promise<FormState> {
  const s = await requireSchoolRole("school_admin");
  let id: string;
  try {
    id = (await createRoute(db, s.ctx, s.ctx.schoolId, routeFields(fd))).id;
  } catch (e) {
    if (e instanceof AppError) return { message: e.message, fields: e.fields };
    throw e;
  }
  revalidatePath("/school/transport", "layout");
  redirect(`/school/transport/routes/${id}`);
}

export async function updateRouteAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateRoute(db, ctx, schoolId, str(fd, "routeId"), routeFields(fd));
    return "Saved.";
  });
}

export async function archiveRouteAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const archived = str(fd, "archived") === "1";
    await setRouteArchived(db, ctx, schoolId, str(fd, "routeId"), archived);
    return archived ? "Route archived." : "Route restored.";
  });
}

export async function addStopAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await addStop(db, ctx, schoolId, str(fd, "routeId"), stopFields(fd));
    return "Stop added.";
  });
}

export async function updateStopAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await updateStop(db, ctx, schoolId, str(fd, "stopId"), stopFields(fd));
    return "Saved.";
  });
}

export async function assignAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    const r = await assignStudent(db, ctx, schoolId, { admissionNo: str(fd, "admissionNo"), routeId: str(fd, "routeId"), stopId: str(fd, "stopId") });
    return r.moved ? `${r.studentName} moved to this route; the previous assignment ended today.` : `${r.studentName} assigned.`;
  });
}

export async function endAssignmentAction(_p: FormState, fd: FormData): Promise<FormState> {
  return act(async (ctx, schoolId) => {
    await endTransportAssignment(db, ctx, schoolId, str(fd, "assignmentId"));
    return "Assignment ended.";
  });
}
