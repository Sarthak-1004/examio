CREATE TABLE "user_mfa" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pending_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_recovery_codes" ADD CONSTRAINT "user_mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_recovery_hash_unique" ON "user_mfa_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "user_mfa_recovery_user_idx" ON "user_mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint

-- =====================================================================
-- Phase 1, task 01.4: two-step sign-in with an authenticator app.
--
-- Required for platform administrators: app_is_platform_admin() is now
-- false until the account has a confirmed authenticator. Optional for
-- school administrators.
--
-- Rollout: deploy with the matching application code. Existing platform
-- administrators lose platform access until they enrol, which they do
-- on their next sign-in.
-- Recovery: forward-fix. Emptying user_mfa removes the second factor
-- for everyone; platform administrators must then enrol again.
-- =====================================================================
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(current_setting('app.platform_admin', true), 'off') = 'on'
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = app_user_id() AND u.is_platform_admin AND u.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM user_mfa f WHERE f.user_id = app_user_id() AND f.confirmed_at IS NOT NULL
    )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- sessions
DROP FUNCTION auth_session_lookup(text);
--> statement-breakpoint
CREATE FUNCTION auth_session_lookup(session_id text)
RETURNS TABLE (user_id uuid, expires_at timestamptz, created_at timestamptz, pending_mfa boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, s.expires_at, s.created_at, s.pending_mfa FROM sessions s WHERE s.id = session_id
$$;
--> statement-breakpoint
-- Turns a pending session into a full one after the second factor succeeded.
CREATE OR REPLACE FUNCTION auth_session_complete_mfa(session_id text, ttl_seconds integer) RETURNS timestamptz
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sessions s
  SET pending_mfa = false,
      expires_at = least(now() + make_interval(secs => ttl_seconds), s.created_at + interval '30 days')
  WHERE s.id = session_id AND s.user_id = app_user_id() AND s.pending_mfa AND s.expires_at > now()
  RETURNING s.expires_at
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- enrolment
-- Only privileged accounts may enrol: platform administrators and active
-- school administrators.
CREATE OR REPLACE FUNCTION auth_mfa_eligible() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = app_user_id() AND u.status = 'active'
      AND (
        u.is_platform_admin
        OR EXISTS (
          SELECT 1 FROM school_memberships m
          WHERE m.user_id = u.id AND m.role = 'school_admin' AND m.status = 'active'
        )
      )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_mfa_own()
RETURNS TABLE (secret_enc text, confirmed boolean, last_used_step bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.secret_enc, f.confirmed_at IS NOT NULL, f.last_used_step
  FROM user_mfa f WHERE f.user_id = app_user_id()
$$;
--> statement-breakpoint
-- Stores a new, unconfirmed secret. Refused once an authenticator is confirmed.
CREATE OR REPLACE FUNCTION auth_mfa_begin(new_secret_enc text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NULL OR NOT auth_mfa_eligible() THEN
    RAISE EXCEPTION 'not allowed to set up two-step sign-in' USING ERRCODE = '42501';
  END IF;
  IF new_secret_enc IS NULL OR length(new_secret_enc) < 16 OR length(new_secret_enc) > 512 THEN
    RAISE EXCEPTION 'invalid secret' USING ERRCODE = '22023';
  END IF;
  INSERT INTO user_mfa AS f (user_id, secret_enc) VALUES (app_user_id(), new_secret_enc)
  ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, created_at = now()
    WHERE f.confirmed_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
-- Confirms enrolment after the first correct code and stores the backup codes.
CREATE OR REPLACE FUNCTION auth_mfa_confirm(accepted_step bigint, recovery_hashes text[]) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_user_id();
BEGIN
  IF me IS NULL OR NOT auth_mfa_eligible() THEN
    RAISE EXCEPTION 'not allowed to set up two-step sign-in' USING ERRCODE = '42501';
  END IF;
  IF recovery_hashes IS NULL OR cardinality(recovery_hashes) < 1 OR cardinality(recovery_hashes) > 20
     OR EXISTS (SELECT 1 FROM unnest(recovery_hashes) h WHERE h !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid recovery codes' USING ERRCODE = '22023';
  END IF;
  UPDATE user_mfa f SET confirmed_at = now(), last_used_step = accepted_step
  WHERE f.user_id = me AND f.confirmed_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM user_mfa_recovery_codes r WHERE r.user_id = me;
  INSERT INTO user_mfa_recovery_codes (user_id, code_hash) SELECT me, h FROM unnest(recovery_hashes) h;
  INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id) VALUES (me, 'auth.mfa_enabled', 'user', me::text);
  RETURN true;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- verification
-- Accepts a time step only if it is newer than every step accepted before,
-- so a code cannot be used twice, even concurrently.
CREATE OR REPLACE FUNCTION auth_mfa_accept_step(candidate_step bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE user_mfa f SET last_used_step = candidate_step
  WHERE f.user_id = app_user_id() AND f.confirmed_at IS NOT NULL AND f.last_used_step < candidate_step;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_mfa_use_recovery_code(candidate_hash text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_user_id();
BEGIN
  UPDATE user_mfa_recovery_codes r SET used_at = now()
  WHERE r.user_id = me AND r.code_hash = candidate_hash AND r.used_at IS NULL
    AND EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id = me AND f.confirmed_at IS NOT NULL);
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id) VALUES (me, 'auth.mfa_recovery_code_used', 'user', me::text);
  RETURN true;
END
$$;
--> statement-breakpoint
-- Platform administrators cannot switch the second factor off.
CREATE OR REPLACE FUNCTION auth_mfa_disable() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_user_id();
BEGIN
  IF me IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = me AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'two-step sign-in cannot be turned off for this account' USING ERRCODE = '42501';
  END IF;
  DELETE FROM user_mfa_recovery_codes r WHERE r.user_id = me;
  DELETE FROM user_mfa f WHERE f.user_id = me;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id) VALUES (me, 'auth.mfa_disabled', 'user', me::text);
  RETURN true;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- recovery
-- Redeeming an activation or reset code now also removes the authenticator:
-- the code is the recovery path for a lost device. Issuing such a code is
-- restricted and audited (platform administrators: operator command only).
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
  DELETE FROM user_mfa_recovery_codes r WHERE r.user_id = tok.user_id;
  DELETE FROM user_mfa f WHERE f.user_id = tok.user_id;
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examio_app') THEN
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO examio_app;
  END IF;
END
$$;
