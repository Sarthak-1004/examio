-- =====================================================================
-- Row Level Security: defence-in-depth tenant isolation.
-- The app connects as `examio_app` (not owner, no BYPASSRLS), and sets
-- app.user_id / app.school_id / app.platform_admin per transaction
-- (see packages/db/src/client.ts withContext). Policies read them here.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_school_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.school_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.platform_admin', true), 'off') = 'on' $$;
--> statement-breakpoint

-- Role checks are SECURITY DEFINER so they can read memberships without
-- recursing through the memberships table's own RLS policy.
CREATE OR REPLACE FUNCTION app_has_school_role(VARIADIC roles membership_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM school_memberships m
    WHERE m.school_id = app_school_id()
      AND m.user_id = app_user_id()
      AND m.status = 'active'
      AND m.role = ANY(roles)
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user_in_current_school(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM school_memberships m
    WHERE m.school_id = app_school_id() AND m.user_id = target
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_member_of(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM school_memberships m
    WHERE m.school_id = target_school AND m.user_id = app_user_id() AND m.status = 'active'
  )
$$;
--> statement-breakpoint

-- Pre-authentication login lookup. `ident` is a lowercased email/username,
-- `phone_digits` the normalised phone (or NULL). Returns several rows when
-- siblings share a phone number.
CREATE OR REPLACE FUNCTION auth_find_login(ident text, phone_digits text)
RETURNS TABLE (id uuid, password_hash text, status user_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.password_hash, u.status
  FROM users u
  WHERE u.email = ident
     OR u.username = ident
     OR (phone_digits IS NOT NULL AND u.phone = phone_digits)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- boards / mediums
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boards_read ON boards FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY boards_write ON boards FOR ALL USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE mediums ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mediums_read ON mediums FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY mediums_write ON mediums FOR ALL USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint

-- ---------------------------------------------------------------- schools
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY schools_select ON schools FOR SELECT
  USING (app_is_platform_admin() OR app_is_member_of(id));
--> statement-breakpoint
CREATE POLICY schools_insert ON schools FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY schools_update ON schools FOR UPDATE
  USING (app_is_platform_admin() OR (id = app_school_id() AND app_has_school_role('school_admin')))
  WITH CHECK (app_is_platform_admin() OR (id = app_school_id() AND app_has_school_role('school_admin')));
--> statement-breakpoint
CREATE POLICY schools_delete ON schools FOR DELETE USING (app_is_platform_admin());
--> statement-breakpoint

-- ---------------------------------------------------------------- school_memberships
ALTER TABLE school_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_select ON school_memberships FOR SELECT
  USING (
    app_is_platform_admin()
    OR user_id = app_user_id()
    OR (school_id = app_school_id() AND app_has_school_role('school_admin', 'teacher'))
  );
--> statement-breakpoint
CREATE POLICY memberships_write ON school_memberships FOR ALL
  USING (app_is_platform_admin() OR (school_id = app_school_id() AND app_has_school_role('school_admin')))
  WITH CHECK (app_is_platform_admin() OR (school_id = app_school_id() AND app_has_school_role('school_admin')));
--> statement-breakpoint

-- ---------------------------------------------------------------- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT
  USING (
    app_is_platform_admin()
    OR id = app_user_id()
    OR (app_has_school_role('school_admin', 'teacher') AND app_user_in_current_school(id))
  );
--> statement-breakpoint
-- Only platform admins may create/flag platform admins.
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (
    app_is_platform_admin()
    OR (app_has_school_role('school_admin') AND is_platform_admin = false)
  );
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    app_is_platform_admin()
    OR id = app_user_id()
    OR (app_has_school_role('school_admin') AND app_user_in_current_school(id))
  )
  WITH CHECK (app_is_platform_admin() OR is_platform_admin = false);
--> statement-breakpoint
CREATE POLICY users_delete ON users FOR DELETE USING (app_is_platform_admin());
--> statement-breakpoint

-- ---------------------------------------------------------------- audit_events (append-only)
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (
    app_is_platform_admin()
    OR (actor_user_id = app_user_id() AND (school_id IS NULL OR (school_id = app_school_id() AND app_is_member_of(school_id))))
  );
--> statement-breakpoint
CREATE POLICY audit_select ON audit_events FOR SELECT
  USING (app_is_platform_admin() OR (school_id = app_school_id() AND app_has_school_role('school_admin')));
