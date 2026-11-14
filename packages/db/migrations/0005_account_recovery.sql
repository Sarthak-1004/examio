CREATE TYPE "public"."account_token_purpose" AS ENUM('activation', 'password_reset');--> statement-breakpoint
CREATE TABLE "account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "account_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"school_id" uuid,
	"issued_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"token_hash" text NOT NULL,
	"recipient_label" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_invitations_not_admin" CHECK ("membership_invitations"."role" <> 'school_admin'),
	CONSTRAINT "membership_invitations_label_length" CHECK (char_length("membership_invitations"."recipient_label") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tokens_hash_unique" ON "account_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_tokens_user_idx" ON "account_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_tokens_expires_idx" ON "account_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invitations_hash_unique" ON "membership_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "membership_invitations_school_idx" ON "membership_invitations" USING btree ("school_id","created_at");--> statement-breakpoint

-- =====================================================================
-- Phase 1, task 01.2: account activation / recovery codes, membership
-- invitations, session lifetime and cleanup.
--
-- account_tokens is a global identity table: RLS enabled with no policy
-- and no runtime privileges; reached only through the auth_* functions.
-- membership_invitations is a tenant table protected by policies.
-- Table privileges are in TABLE_GRANTS (scripts/setup-roles.ts).
--
-- Rollout: deploy with the matching application code (auth_session_lookup
-- changes its result columns).
-- Recovery: forward-fix. Both new tables can be emptied without affecting
-- existing accounts; outstanding codes then simply stop working.
-- =====================================================================
ALTER TABLE account_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership_invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------- sessions
-- Also returns created_at so the application can apply an absolute lifetime.
DROP FUNCTION auth_session_lookup(text);
--> statement-breakpoint
CREATE FUNCTION auth_session_lookup(session_id text)
RETURNS TABLE (user_id uuid, expires_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, s.expires_at, s.created_at FROM sessions s WHERE s.id = session_id
$$;
--> statement-breakpoint

-- Who may act on the account of another user: a platform administrator for any
-- active non-platform user, or a school administrator for a user they manage.
CREATE OR REPLACE FUNCTION app_can_recover_user(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = target AND u.status = 'active' AND NOT u.is_platform_admin)
    AND (app_is_platform_admin() OR app_can_manage_user(target))
$$;
--> statement-breakpoint

-- Signs a user out everywhere. Allowed for the user themself and for whoever
-- may recover the account.
CREATE OR REPLACE FUNCTION auth_revoke_user_sessions(target uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  removed integer;
BEGIN
  IF target IS NULL OR NOT (target = app_user_id() OR app_can_recover_user(target)) THEN
    RAISE EXCEPTION 'not allowed to revoke sessions for this user' USING ERRCODE = '42501';
  END IF;
  DELETE FROM sessions s WHERE s.user_id = target;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- account codes
-- Issues a single-use code (stored as a hash) and cancels any earlier
-- outstanding code for the same user.
CREATE OR REPLACE FUNCTION auth_issue_account_token(
  target uuid, token_purpose account_token_purpose, new_token_hash text, ttl_seconds integer
) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  expires timestamptz;
BEGIN
  IF new_token_hash IS NULL OR new_token_hash !~ '^[0-9a-f]{64}$'
     OR token_purpose IS NULL
     OR ttl_seconds IS NULL OR ttl_seconds < 60 OR ttl_seconds > 7 * 86400 THEN
    RAISE EXCEPTION 'invalid account token arguments' USING ERRCODE = '22023';
  END IF;
  IF target IS NULL OR NOT app_can_recover_user(target) THEN
    RAISE EXCEPTION 'not allowed to issue an account code for this user' USING ERRCODE = '42501';
  END IF;

  UPDATE account_tokens t SET revoked_at = now()
  WHERE t.user_id = target AND t.consumed_at IS NULL AND t.revoked_at IS NULL;

  expires := now() + make_interval(secs => ttl_seconds);
  INSERT INTO account_tokens (user_id, purpose, token_hash, school_id, issued_by, expires_at)
  VALUES (
    target, token_purpose, new_token_hash,
    CASE WHEN app_is_platform_admin() THEN NULL ELSE app_school_id() END,
    app_user_id(), expires
  );
  RETURN expires;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_revoke_account_tokens(target uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cancelled integer;
BEGIN
  IF target IS NULL OR NOT app_can_recover_user(target) THEN
    RAISE EXCEPTION 'not allowed to revoke account codes for this user' USING ERRCODE = '42501';
  END IF;
  UPDATE account_tokens t SET revoked_at = now()
  WHERE t.user_id = target AND t.consumed_at IS NULL AND t.revoked_at IS NULL;
  GET DIAGNOSTICS cancelled = ROW_COUNT;
  RETURN cancelled;
END
$$;
--> statement-breakpoint

-- Cheap pre-check used before the new password is hashed. Reveals only
-- whether an unguessable code is currently usable.
CREATE OR REPLACE FUNCTION auth_check_account_token(candidate_hash text)
RETURNS TABLE (purpose account_token_purpose)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.purpose
  FROM account_tokens t JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = candidate_hash
    AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
    AND u.status = 'active'
$$;
--> statement-breakpoint

-- Consumes a code exactly once and sets the new password. The same statement
-- claims the code, so concurrent or repeated redemptions cannot both succeed.
-- All sessions and other outstanding codes of the user are cancelled.
CREATE OR REPLACE FUNCTION auth_redeem_account_token(candidate_hash text, new_password_hash text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tok record;
BEGIN
  IF new_password_hash IS NULL OR length(new_password_hash) = 0 THEN
    RAISE EXCEPTION 'invalid password hash' USING ERRCODE = '22023';
  END IF;

  UPDATE account_tokens t SET consumed_at = now()
  FROM users u
  WHERE t.token_hash = candidate_hash
    AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
    AND u.id = t.user_id AND u.status = 'active'
  RETURNING t.user_id, t.purpose, t.school_id INTO tok;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE users SET password_hash = new_password_hash, must_change_password = false WHERE id = tok.user_id;
  DELETE FROM sessions s WHERE s.user_id = tok.user_id;
  UPDATE account_tokens t SET revoked_at = now()
  WHERE t.user_id = tok.user_id AND t.consumed_at IS NULL AND t.revoked_at IS NULL;
  INSERT INTO audit_events (school_id, actor_user_id, action, entity_type, entity_id)
  VALUES (
    tok.school_id, tok.user_id,
    CASE tok.purpose WHEN 'activation' THEN 'auth.account_activated' ELSE 'auth.password_reset_completed' END,
    'user', tok.user_id::text
  );
  RETURN tok.user_id;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- membership invitations
CREATE POLICY invitations_select ON membership_invitations FOR SELECT
  USING (school_id = app_school_id() AND app_has_school_role('school_admin'));
--> statement-breakpoint
CREATE POLICY invitations_insert ON membership_invitations FOR INSERT
  WITH CHECK (
    school_id = app_school_id()
    AND app_has_school_role('school_admin')
    AND invited_by = app_user_id()
    AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NULL
    AND expires_at > now() AND expires_at <= now() + interval '7 days'
  );
--> statement-breakpoint
-- Only `revoked_at` is updatable by the runtime role (column privilege), and
-- only while the invitation is still open.
CREATE POLICY invitations_update ON membership_invitations FOR UPDATE
  USING (school_id = app_school_id() AND app_has_school_role('school_admin') AND accepted_at IS NULL)
  WITH CHECK (school_id = app_school_id() AND app_has_school_role('school_admin'));
--> statement-breakpoint

-- The signed-in user accepts an invitation: that is their consent to join.
-- Platform administrators cannot hold invited memberships.
CREATE OR REPLACE FUNCTION auth_accept_membership_invitation(candidate_hash text)
RETURNS TABLE (joined_school_id uuid, joined_role membership_role)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_user_id();
  inv record;
BEGIN
  IF me IS NULL OR NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = me AND u.status = 'active' AND NOT u.is_platform_admin
  ) THEN
    RAISE EXCEPTION 'not allowed to accept an invitation' USING ERRCODE = '42501';
  END IF;

  UPDATE membership_invitations i SET accepted_at = now(), accepted_by = me
  FROM schools s
  WHERE i.token_hash = candidate_hash
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    AND s.id = i.school_id AND s.status <> 'suspended'
  RETURNING i.id, i.school_id, i.role INTO inv;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO school_memberships AS m (school_id, user_id, role)
  VALUES (inv.school_id, me, inv.role)
  ON CONFLICT (school_id, user_id, role) DO UPDATE SET status = 'active';

  INSERT INTO audit_events (school_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (inv.school_id, me, 'membership.invitation_accepted', 'membership_invitation', inv.id::text,
          jsonb_build_object('role', inv.role));

  RETURN QUERY SELECT inv.school_id, inv.role;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- cleanup
-- Removes records that can no longer be used. Safe to call at any time; run
-- opportunistically until a scheduled job exists (Phase 2).
CREATE OR REPLACE FUNCTION auth_purge_expired() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM sessions WHERE expires_at < now() - interval '1 day';
  DELETE FROM account_tokens WHERE expires_at < now() - interval '30 days';
  DELETE FROM membership_invitations WHERE accepted_at IS NULL AND expires_at < now() - interval '30 days';
$$;
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
