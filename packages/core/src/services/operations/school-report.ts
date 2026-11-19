import { sql } from "drizzle-orm";
import type { Db, RequestContext } from "@examio/db";
import { withCapability, type PlanModule } from "../../capabilities";

/**
 * School reports (Phase 15.2): the core figures and those of exams, staff leave and payroll for
 * one page, computed in one transaction. Optional modules outside the school's plan come back as
 * null. Fees, admissions, library, inventory and transport have their own summaries
 * (Phases 8 and 13.5).
 */

export interface SchoolReport {
  modules: PlanModule[];
  students: { active: number; admittedThisYear: number };
  staff: { active: number };
  attendance: { marks: number; presentPercent: number | null };
  homework: { publishedLast30: number; dueNext7: number };
  exams: { publishedThisYear: number; attemptsLast30: number; resultsReleased: number } | null;
  leave: { pending: number; onLeaveToday: number } | null;
  payroll: { lastMonth: string | null; lastStatus: string | null; lastNetPaise: number | null; adjustmentsPending: number } | null;
}

export async function getSchoolReport(db: Db, ctx: RequestContext, schoolId: string): Promise<SchoolReport> {
  return withCapability(db, ctx, schoolId, "school.reports.view", async (tx, actor) => {
    const on = (m: PlanModule) => actor.modules.includes(m);
    const [core] = (await tx.execute(sql`
      with t as (select (now() at time zone timezone)::date as today from schools where id = ${schoolId}::uuid),
           y as (select starts_on from academic_years where school_id = ${schoolId}::uuid and status = 'current')
      select (select count(*)::int from student_profiles where school_id = ${schoolId}::uuid and status = 'active') as "studentsActive",
             (select count(*)::int from student_profiles where school_id = ${schoolId}::uuid and admitted_on >= coalesce((select starts_on from y), (select today from t) - 365)) as "admittedThisYear",
             (select count(*)::int from staff_profiles where school_id = ${schoolId}::uuid and status = 'active') as "staffActive",
             (select count(*)::int from attendance_records where school_id = ${schoolId}::uuid and attendance_date > (select today from t) - 30) as marks,
             (select round(100.0 * count(*) filter (where status in ('present', 'late')) / nullif(count(*) filter (where status <> 'excused'), 0), 1)::float8
                from attendance_records where school_id = ${schoolId}::uuid and attendance_date > (select today from t) - 30) as "presentPercent",
             (select count(*)::int from homework where school_id = ${schoolId}::uuid and status = 'published' and published_at > now() - interval '30 days') as "hwPublished",
             (select count(*)::int from homework where school_id = ${schoolId}::uuid and status = 'published' and due_at between now() and now() + interval '7 days') as "hwDue"`)) as unknown as {
      studentsActive: number;
      admittedThisYear: number;
      staffActive: number;
      marks: number;
      presentPercent: number | null;
      hwPublished: number;
      hwDue: number;
    }[];
    let exams: SchoolReport["exams"] = null;
    if (on("exams")) {
      const [e] = (await tx.execute(sql`
        select (select count(*)::int from exams where school_id = ${schoolId}::uuid and status <> 'draft'
                  and academic_year_id = (select id from academic_years where school_id = ${schoolId}::uuid and status = 'current')) as "publishedThisYear",
               (select count(*)::int from exam_attempts where school_id = ${schoolId}::uuid and started_at > now() - interval '30 days') as "attemptsLast30",
               (select count(*)::int from exam_result_sets where school_id = ${schoolId}::uuid and released_at is not null) as "resultsReleased"`)) as unknown as NonNullable<SchoolReport["exams"]>[];
      exams = e ?? null;
    }
    let leave: SchoolReport["leave"] = null;
    if (on("hr")) {
      const [l] = (await tx.execute(sql`
        select (select count(*)::int from hr_leave_requests where school_id = ${schoolId}::uuid and status = 'pending') as pending,
               (select count(*)::int from hr_staff_attendance a join schools s on s.id = a.school_id
                 where a.school_id = ${schoolId}::uuid and a.status in ('leave', 'half_leave') and a.on = (now() at time zone s.timezone)::date) as "onLeaveToday"`)) as unknown as NonNullable<SchoolReport["leave"]>[];
      leave = l ?? null;
    }
    let payroll: SchoolReport["payroll"] = null;
    if (on("payroll")) {
      const [p] = (await tx.execute(sql`
        select to_char(r.period_start, 'YYYY-MM') as "lastMonth", r.status::text as "lastStatus",
               (select sum(net_paise)::float8 from payroll_slips s where s.run_id = r.id and s.included) as "lastNetPaise",
               (select count(*)::int from payroll_adjustments where school_id = ${schoolId}::uuid and status = 'pending') as "adjustmentsPending"
        from (select 1) x left join lateral (select * from payroll_runs where school_id = ${schoolId}::uuid order by period_start desc limit 1) r on true`)) as unknown as NonNullable<SchoolReport["payroll"]>[];
      payroll = p ?? null;
    }
    return {
      modules: [...actor.modules],
      students: { active: core!.studentsActive, admittedThisYear: core!.admittedThisYear },
      staff: { active: core!.staffActive },
      attendance: { marks: core!.marks, presentPercent: core!.presentPercent },
      homework: { publishedLast30: core!.hwPublished, dueNext7: core!.hwDue },
      exams,
      leave,
      payroll,
    };
  });
}
