-- =====================================================================
-- Phase 1, task 01.1: identity, membership and tenant boundary hardening.
--
-- Changes policies, helper functions and function privileges only; no
-- table data is rewritten. Table-level privileges for the runtime role
-- are applied by packages/db/scripts/setup-roles.ts, which must run
-- after this migration (`pnpm db:migrate` does so).
--
-- Rollout: deploy together with the application code that uses the
-- auth_* helpers. Older application code cannot read sessions or
-- password hashes once this is applied.
-- Recovery: forward-fix. The previous definitions are in
-- 0001_rls_policies.sql and can be re-applied by a new migration.
-- =====================================================================

-- ---------------------------------------------------------------- context helpers

-- The platform flag alone is no longer trusted: the acting user must be an
-- active platform administrator in the users table.
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('app.platform_admin', true), 'off') = 'on'
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = app_user_id() AND u.is_platform_admin AND u.status = 'active'
    )
$$;
--> statement-breakpoint

-- School roles require an active membership, an active account and a school
-- that is not suspended.
CREATE OR REPLACE FUNCTION app_has_school_role(VARIADIC roles membership_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM school_memberships m
    JOIN schools s ON s.id = m.school_id
    JOIN users u ON u.id = m.user_id
    WHERE m.school_id = app_school_id()
      AND m.user_id = app_user_id()
      AND m.status = 'active'
      AND m.role = ANY(roles)
      AND s.status <> 'suspended'
      AND u.status = 'active'
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_member_of(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM school_memberships m
    JOIN schools s ON s.id = m.school_id
    JOIN users u ON u.id = m.user_id
    WHERE m.school_id = target_school
      AND m.user_id = app_user_id()
      AND m.status = 'active'
      AND s.status <> 'suspended'
      AND u.status = 'active'
  )
$$;
--> statement-breakpoint

-- A school administrator may manage the identity (profile, credentials,
-- status) of a user only when that user belongs to the administrator's
-- school alone, is not a platform administrator, is not a school
-- administrator of that school and is not the administrator themself.
CREATE OR REPLACE FUNCTION app_can_manage_user(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_school_role('school_admin')
    AND target <> app_user_id()
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = target AND NOT u.is_platform_admin)
    AND EXISTS (
      SELECT 1 FROM school_memberships m
      WHERE m.user_id = target AND m.school_id = app_school_id() AND m.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM school_memberships m
      WHERE m.user_id = target AND m.status = 'active'
        AND (m.school_id <> app_school_id() OR m.role = 'school_admin')
    )
$$;
--> statement-breakpoint

-- A school administrator may grant a membership in their own school to a user
-- who is active, is not a platform administrator and has no active membership
-- in any other school. Linking an identity that already belongs to another
-- school needs the recipient's consent (invitation flow, task 01.2).
CREATE OR REPLACE FUNCTION app_can_grant_membership(target_user uuid, target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target_school = app_school_id()
    AND app_has_school_role('school_admin')
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = target_user AND NOT u.is_platform_admin AND u.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM school_memberships m
      WHERE m.user_id = target_user AND m.school_id <> target_school AND m.status = 'active'
    )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- reviewed auth helpers

-- Session lookup by token hash happens before the user is known, so it cannot
-- go through the sessions policy.
CREATE OR REPLACE FUNCTION auth_session_lookup(session_id text)
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, s.expires_at FROM sessions s WHERE s.id = session_id
$$;
--> statement-breakpoint

-- The runtime role cannot select users.password_hash. A signed-in user may
-- read and replace only their own hash through these helpers.
CREATE OR REPLACE FUNCTION auth_own_password_hash() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.password_hash FROM users u WHERE u.id = app_user_id() AND u.status = 'active'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_set_own_password(new_hash text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH changed AS (
    UPDATE users SET password_hash = new_hash, must_change_password = false
    WHERE id = app_user_id() AND status = 'active' AND length(new_hash) > 0
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- sessions
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sessions_own ON sessions FOR ALL
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
--> statement-breakpoint

-- ---------------------------------------------------------------- users
DROP POLICY users_insert ON users;
--> statement-breakpoint
DROP POLICY users_update ON users;
--> statement-breakpoint
DROP POLICY users_delete ON users;
--> statement-breakpoint
-- Platform administrators cannot be created through the runtime role at all.
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (
    is_platform_admin = false
    AND (app_is_platform_admin() OR app_has_school_role('school_admin'))
  );
--> statement-breakpoint
-- No direct self-update: own password changes use auth_set_own_password().
CREATE POLICY users_update ON users FOR UPDATE
  USING ((app_is_platform_admin() AND is_platform_admin = false) OR app_can_manage_user(id))
  WITH CHECK (is_platform_admin = false AND (app_is_platform_admin() OR app_can_manage_user(id)));
--> statement-breakpoint

-- ---------------------------------------------------------------- school_memberships
DROP POLICY memberships_write ON school_memberships;
--> statement-breakpoint
CREATE POLICY memberships_insert ON school_memberships FOR INSERT
  WITH CHECK (app_is_platform_admin() OR app_can_grant_membership(user_id, school_id));
--> statement-breakpoint
-- Only `status` is updatable by the runtime role (column privilege).
-- Revoking is always allowed for the school's administrators; re-activating
-- must satisfy the same rule as a new grant.
CREATE POLICY memberships_update ON school_memberships FOR UPDATE
  USING (app_is_platform_admin() OR (school_id = app_school_id() AND app_has_school_role('school_admin')))
  WITH CHECK (
    app_is_platform_admin()
    OR (
      school_id = app_school_id()
      AND app_has_school_role('school_admin')
      AND (status = 'revoked' OR app_can_grant_membership(user_id, school_id))
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------- schools
DROP POLICY schools_delete ON schools;
--> statement-breakpoint
-- School administrators may edit their school's profile, but status, board and
-- medium are platform decisions. Connections that bypass row security
-- (migrations, fixtures) are not restricted.
CREATE OR REPLACE FUNCTION schools_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF row_security_active('public.schools'::regclass)
     AND NOT app_is_platform_admin()
     AND (NEW.status, NEW.board_id, NEW.medium_id) IS DISTINCT FROM (OLD.status, OLD.board_id, OLD.medium_id) THEN
    RAISE EXCEPTION 'only platform administrators can change school status, board or medium'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER schools_guard_update BEFORE UPDATE ON schools
  FOR EACH ROW EXECUTE FUNCTION schools_guard_update();
--> statement-breakpoint

-- ---------------------------------------------------------------- audit_events
DROP POLICY audit_insert ON audit_events;
--> statement-breakpoint
-- The actor is always the acting user, including for platform administrators.
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (
    actor_user_id = app_user_id()
    AND (
      app_is_platform_admin()
      OR school_id IS NULL
      OR (school_id = app_school_id() AND app_is_member_of(school_id))
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------- function privileges
-- Functions are executable by PUBLIC by default, which would let any database
-- login call the SECURITY DEFINER helpers (including auth_find_login).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examio_app') THEN
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO examio_app;
  END IF;
END
$$;
