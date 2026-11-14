CREATE TABLE "support_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_reason_length" CHECK (char_length("support_access_grants"."reason") between 10 and 500),
	CONSTRAINT "support_access_duration" CHECK ("support_access_grants"."expires_at" > "support_access_grants"."created_at" and "support_access_grants"."expires_at" <= "support_access_grants"."created_at" + interval '4 hours')
);
--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_platform_user_id_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_access_school_idx" ON "support_access_grants" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "support_access_user_idx" ON "support_access_grants" USING btree ("platform_user_id","expires_at");--> statement-breakpoint

-- =====================================================================
-- Phase 1, task 01.4: audited, time-limited platform support access.
--
-- Before this migration a platform administrator could read and change
-- every user, membership and audit event of every school. Afterwards the
-- routine platform view is limited to schools, lookups, platform
-- administrators and school administrators (needed for onboarding and
-- recovery). Anything else in a school needs an open support grant for
-- that school, which the school can see.
--
-- No data is rewritten. Rollout: deploy with the matching application
-- code. Recovery: forward-fix; the previous policy definitions are in
-- 0002_identity_hardening.sql and 0005_account_recovery.sql.
-- =====================================================================
ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_has_support_access(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_is_platform_admin() AND EXISTS (
    SELECT 1 FROM support_access_grants g
    WHERE g.platform_user_id = app_user_id()
      AND g.school_id = target_school
      AND g.ended_at IS NULL
      AND g.expires_at > now()
  )
$$;
--> statement-breakpoint

-- Users a platform administrator may see: platform administrators, school
-- administrators of any school, and members of a school under an open grant.
CREATE OR REPLACE FUNCTION app_platform_can_see_user(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_is_platform_admin() AND (
    EXISTS (SELECT 1 FROM users u WHERE u.id = target AND u.is_platform_admin)
    OR EXISTS (
      SELECT 1 FROM school_memberships m
      WHERE m.user_id = target AND (m.role = 'school_admin' OR app_has_support_access(m.school_id))
    )
  )
$$;
--> statement-breakpoint

-- Aggregate only: lets the platform listing show school size without
-- exposing who the members are.
CREATE OR REPLACE FUNCTION platform_school_member_count(target_school uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN app_is_platform_admin()
    THEN (SELECT count(*)::integer FROM school_memberships m WHERE m.school_id = target_school)
  END
$$;
--> statement-breakpoint

-- Account recovery by a platform administrator now follows the same limit.
CREATE OR REPLACE FUNCTION app_can_recover_user(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = target AND u.status = 'active' AND NOT u.is_platform_admin)
    AND (app_platform_can_see_user(target) OR app_can_manage_user(target))
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- users
DROP POLICY users_select ON users;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT
  USING (
    id = app_user_id()
    OR app_platform_can_see_user(id)
    OR (app_has_school_role('school_admin', 'teacher') AND app_user_in_current_school(id))
  );
--> statement-breakpoint
DROP POLICY users_update ON users;
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE
  USING ((is_platform_admin = false AND app_platform_can_see_user(id)) OR app_can_manage_user(id))
  WITH CHECK (is_platform_admin = false AND (app_platform_can_see_user(id) OR app_can_manage_user(id)));
--> statement-breakpoint

-- ---------------------------------------------------------------- school_memberships
DROP POLICY memberships_select ON school_memberships;
--> statement-breakpoint
CREATE POLICY memberships_select ON school_memberships FOR SELECT
  USING (
    user_id = app_user_id()
    OR (app_is_platform_admin() AND (role = 'school_admin' OR app_has_support_access(school_id)))
    OR (school_id = app_school_id() AND app_has_school_role('school_admin', 'teacher'))
  );
--> statement-breakpoint
DROP POLICY memberships_insert ON school_memberships;
--> statement-breakpoint
CREATE POLICY memberships_insert ON school_memberships FOR INSERT
  WITH CHECK (
    (app_is_platform_admin() AND (role = 'school_admin' OR app_has_support_access(school_id)))
    OR app_can_grant_membership(user_id, school_id)
  );
--> statement-breakpoint
DROP POLICY memberships_update ON school_memberships;
--> statement-breakpoint
CREATE POLICY memberships_update ON school_memberships FOR UPDATE
  USING (
    (app_is_platform_admin() AND (role = 'school_admin' OR app_has_support_access(school_id)))
    OR (school_id = app_school_id() AND app_has_school_role('school_admin'))
  )
  WITH CHECK (
    (app_is_platform_admin() AND (role = 'school_admin' OR app_has_support_access(school_id)))
    OR (
      school_id = app_school_id()
      AND app_has_school_role('school_admin')
      AND (status = 'revoked' OR app_can_grant_membership(user_id, school_id))
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------- audit_events
DROP POLICY audit_select ON audit_events;
--> statement-breakpoint
-- A platform administrator reads platform-level events of users they may
-- see, events of a school under an open grant, and what platform
-- administrators themselves did in any school.
CREATE POLICY audit_select ON audit_events FOR SELECT
  USING (
    (school_id = app_school_id() AND app_has_school_role('school_admin'))
    OR (
      app_is_platform_admin() AND (
        (school_id IS NULL AND (actor_user_id IS NULL OR app_platform_can_see_user(actor_user_id)))
        OR (school_id IS NOT NULL AND app_has_support_access(school_id))
        OR EXISTS (SELECT 1 FROM users u WHERE u.id = actor_user_id AND u.is_platform_admin)
      )
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------- support_access_grants
-- Visible to every platform administrator (peer oversight) and to the
-- administrators of the school concerned (transparency).
CREATE POLICY support_access_select ON support_access_grants FOR SELECT
  USING (
    app_is_platform_admin()
    OR (school_id = app_school_id() AND app_has_school_role('school_admin'))
  );
--> statement-breakpoint
CREATE POLICY support_access_insert ON support_access_grants FOR INSERT
  WITH CHECK (
    app_is_platform_admin()
    AND platform_user_id = app_user_id()
    AND ended_at IS NULL
    AND expires_at > now() AND expires_at <= now() + interval '4 hours'
  );
--> statement-breakpoint
-- Only `ended_at` is updatable by the runtime role (column privilege): an
-- open grant can be ended by its holder, never extended or reopened.
CREATE POLICY support_access_update ON support_access_grants FOR UPDATE
  USING (app_is_platform_admin() AND platform_user_id = app_user_id() AND ended_at IS NULL)
  WITH CHECK (platform_user_id = app_user_id() AND ended_at IS NOT NULL);
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examio_app') THEN
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO examio_app;
  END IF;
END
$$;
