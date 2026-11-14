CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'dead');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'delivered', 'sandboxed', 'failed');--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_key_format" CHECK (char_length("idempotency_records"."key") between 8 and 128)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_kind_format" CHECK ("jobs"."kind" ~ '^[a-z][a-z0-9_.]{2,63}$'),
	CONSTRAINT "jobs_attempts_range" CHECK ("jobs"."max_attempts" between 1 and 25 and "jobs"."attempts" >= 0),
	CONSTRAINT "jobs_payload_size" CHECK (octet_length("jobs"."payload"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid,
	"recipient_user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"template" text NOT NULL,
	"params" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"provider" text,
	"provider_ref" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_params_size" CHECK (octet_length("notifications"."params"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_unique" ON "idempotency_records" USING btree ("actor_user_id","operation","key");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_dedupe_unique" ON "jobs" USING btree ("kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_school_idx" ON "jobs" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_unique" ON "notifications" USING btree ("dedupe_key","recipient_user_id","channel");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_school_idx" ON "notifications" USING btree ("school_id","created_at");--> statement-breakpoint

-- =====================================================================
-- Phase 2, task 02.4: background jobs, notifications, idempotency.
--
-- jobs and worker_heartbeats: no runtime table privileges; reached only
-- through the job_* / worker_* functions below.
-- notifications: recipients read their own; created only through
-- notification_queue*; status changed only by the worker.
-- idempotency_records: each user sees and writes only their own.
--
-- Worker context: the worker process sets app.worker = 'on' for its own
-- transactions (withWorkerContext). Like every app.* setting it is
-- trusted server-side context: anyone holding the application database
-- credential can set it, so it guards against application mistakes, not
-- against a stolen credential.
--
-- Recovery: forward-fix. Queued jobs can be left in place across a
-- rollback of application code; succeeded and dead jobs are history.
-- =====================================================================
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_is_worker() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.worker', true), 'off') = 'on' $$;
--> statement-breakpoint

-- ---------------------------------------------------------------- jobs
-- Enqueue inside the caller's transaction. A school job may be created by a
-- member of that school, a platform administrator or the worker.
CREATE OR REPLACE FUNCTION job_enqueue(
  job_kind text, job_payload jsonb, job_dedupe_key text, job_school uuid, job_run_at timestamptz, job_max_attempts integer
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  new_id uuid;
BEGIN
  IF job_school IS NOT NULL AND NOT (app_is_worker() OR app_is_platform_admin() OR app_is_member_of(job_school)) THEN
    RAISE EXCEPTION 'not allowed to queue work for this school' USING ERRCODE = '42501';
  END IF;
  INSERT INTO jobs (school_id, kind, payload, dedupe_key, run_at, max_attempts)
  VALUES (job_school, job_kind, coalesce(job_payload, '{}'::jsonb), job_dedupe_key, coalesce(job_run_at, now()), coalesce(job_max_attempts, 8))
  ON CONFLICT (kind, dedupe_key) DO NOTHING
  RETURNING id INTO new_id;
  IF new_id IS NULL THEN
    SELECT j.id INTO new_id FROM jobs j WHERE j.kind = job_kind AND j.dedupe_key = job_dedupe_key;
  END IF;
  RETURN new_id;
END
$$;
--> statement-breakpoint

-- Claims due jobs for one worker. A job whose lease expired (worker died) is
-- claimed again, unless it has used all attempts, in which case it is dead.
CREATE OR REPLACE FUNCTION job_claim(worker text, job_kinds text[], max_jobs integer, lease_seconds integer)
RETURNS TABLE (id uuid, kind text, payload jsonb, school_id uuid, attempts integer, max_attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may claim jobs' USING ERRCODE = '42501';
  END IF;
  IF worker IS NULL OR length(worker) NOT BETWEEN 1 AND 100 OR max_jobs NOT BETWEEN 1 AND 100 OR lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'invalid claim arguments' USING ERRCODE = '22023';
  END IF;

  UPDATE jobs j SET status = 'dead', finished_at = now(), updated_at = now(), locked_by = NULL, locked_until = NULL,
    last_error = coalesce(j.last_error || ' | ', '') || 'worker stopped responding during the final attempt'
  WHERE j.status = 'running' AND j.locked_until < now() AND j.attempts >= j.max_attempts;

  RETURN QUERY
  UPDATE jobs j SET status = 'running', attempts = j.attempts + 1, locked_by = worker,
    locked_until = now() + make_interval(secs => lease_seconds), updated_at = now()
  WHERE j.id IN (
    SELECT c.id FROM jobs c
    WHERE c.kind = ANY(job_kinds)
      AND ((c.status = 'queued' AND c.run_at <= now()) OR (c.status = 'running' AND c.locked_until < now()))
    ORDER BY c.run_at, c.id
    LIMIT max_jobs
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.id, j.kind, j.payload, j.school_id, j.attempts, j.max_attempts;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION job_complete(job_id uuid, worker text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may complete jobs' USING ERRCODE = '42501';
  END IF;
  UPDATE jobs SET status = 'succeeded', finished_at = now(), updated_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
  WHERE id = job_id AND status = 'running' AND locked_by = worker;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
-- Records a failed attempt: retried after the given delay, or dead when no
-- attempts remain or the failure is permanent (retry_delay_seconds NULL).
CREATE OR REPLACE FUNCTION job_fail(job_id uuid, worker text, error_text text, retry_delay_seconds integer)
RETURNS job_status
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result job_status;
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may fail jobs' USING ERRCODE = '42501';
  END IF;
  UPDATE jobs j SET
    status = CASE WHEN retry_delay_seconds IS NULL OR j.attempts >= j.max_attempts THEN 'dead'::job_status ELSE 'queued'::job_status END,
    run_at = CASE WHEN retry_delay_seconds IS NULL THEN j.run_at ELSE now() + make_interval(secs => greatest(retry_delay_seconds, 0)) END,
    finished_at = CASE WHEN retry_delay_seconds IS NULL OR j.attempts >= j.max_attempts THEN now() END,
    last_error = left(coalesce(error_text, 'unknown error'), 1000),
    locked_by = NULL, locked_until = NULL, updated_at = now()
  WHERE j.id = job_id AND j.status = 'running' AND j.locked_by = worker
  RETURNING j.status INTO result;
  RETURN result;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worker_heartbeat(worker text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may report in' USING ERRCODE = '42501';
  END IF;
  INSERT INTO worker_heartbeats AS h (worker_id) VALUES (left(worker, 100))
  ON CONFLICT (worker_id) DO UPDATE SET seen_at = now();
  DELETE FROM worker_heartbeats WHERE seen_at < now() - interval '7 days';
END
$$;
--> statement-breakpoint

-- Operational view for platform administrators and the worker. Counts only.
CREATE OR REPLACE FUNCTION job_stats()
RETURNS TABLE (queued bigint, running bigint, dead bigint, oldest_due_seconds integer, last_worker_seen timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_is_platform_admin() OR app_is_worker()) THEN
    RAISE EXCEPTION 'not allowed to read job statistics' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT
    count(*) FILTER (WHERE j.status = 'queued'),
    count(*) FILTER (WHERE j.status = 'running'),
    count(*) FILTER (WHERE j.status = 'dead'),
    coalesce(extract(epoch FROM now() - min(j.run_at) FILTER (WHERE j.status = 'queued' AND j.run_at <= now()))::integer, 0),
    (SELECT max(h.seen_at) FROM worker_heartbeats h)
  FROM jobs j;
END
$$;
--> statement-breakpoint
-- Dead-letter inspection: kind, school, attempts and error. Payloads are not
-- shown; they hold identifiers only.
CREATE OR REPLACE FUNCTION job_admin_list(wanted job_status, max_rows integer)
RETURNS TABLE (id uuid, kind text, school_id uuid, status job_status, attempts integer, max_attempts integer,
               last_error text, created_at timestamptz, run_at timestamptz, finished_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_platform_admin() THEN
    RAISE EXCEPTION 'not allowed to inspect jobs' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT j.id, j.kind, j.school_id, j.status, j.attempts, j.max_attempts, j.last_error, j.created_at, j.run_at, j.finished_at
  FROM jobs j WHERE j.status = wanted ORDER BY coalesce(j.finished_at, j.created_at) DESC, j.id
  LIMIT least(greatest(coalesce(max_rows, 50), 1), 200);
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION job_admin_retry(job_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  retried record;
BEGIN
  IF NOT app_is_platform_admin() THEN
    RAISE EXCEPTION 'not allowed to retry jobs' USING ERRCODE = '42501';
  END IF;
  UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), finished_at = NULL, updated_at = now()
  WHERE id = job_id AND status = 'dead'
  RETURNING id, kind INTO retried;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, data)
  VALUES (app_user_id(), 'job.retried', 'job', retried.id::text, jsonb_build_object('kind', retried.kind));
  RETURN true;
END
$$;
--> statement-breakpoint
-- Removes finished history: succeeded after 14 days, dead after 90 days.
CREATE OR REPLACE FUNCTION job_purge_finished() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  removed integer;
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may purge jobs' USING ERRCODE = '42501';
  END IF;
  DELETE FROM jobs WHERE (status = 'succeeded' AND finished_at < now() - interval '14 days')
                      OR (status = 'dead' AND finished_at < now() - interval '90 days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM idempotency_records WHERE expires_at < now();
  DELETE FROM rate_limit_buckets WHERE reset_at < now() - interval '1 hour';
  RETURN removed;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- notifications
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (
    recipient_user_id = app_user_id()
    OR (school_id = app_school_id() AND app_has_school_role('school_admin'))
  );
--> statement-breakpoint
-- Only `read_at` is updatable by the runtime role, and only by the recipient.
CREATE POLICY notifications_mark_read ON notifications FOR UPDATE
  USING (recipient_user_id = app_user_id())
  WITH CHECK (recipient_user_id = app_user_id());
--> statement-breakpoint

-- Queues one notification per channel for one recipient, with its delivery
-- job, in the caller's transaction. Repeating the same dedupe key is a no-op.
CREATE OR REPLACE FUNCTION notification_queue(
  recipient uuid, target_school uuid, channels notification_channel[], template_name text, template_params jsonb, dedupe text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ch notification_channel;
  new_id uuid;
  queued integer := 0;
BEGIN
  IF template_name !~ '^[a-z][a-z0-9_.]{2,63}$' OR dedupe IS NULL OR length(dedupe) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid notification arguments' USING ERRCODE = '22023';
  END IF;
  IF NOT (app_is_worker() OR app_is_platform_admin()
          OR (target_school IS NOT NULL AND app_is_member_of(target_school)
              AND EXISTS (SELECT 1 FROM school_memberships m WHERE m.user_id = recipient AND m.school_id = target_school AND m.status = 'active'))) THEN
    RAISE EXCEPTION 'not allowed to notify this person' USING ERRCODE = '42501';
  END IF;
  FOREACH ch IN ARRAY channels LOOP
    -- No address, no email: skip rather than fail.
    CONTINUE WHEN ch = 'email' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = recipient AND u.email IS NOT NULL);
    INSERT INTO notifications (school_id, recipient_user_id, channel, template, params, dedupe_key)
    VALUES (target_school, recipient, ch, template_name, coalesce(template_params, '{}'::jsonb), dedupe)
    ON CONFLICT (dedupe_key, recipient_user_id, channel) DO NOTHING
    RETURNING id INTO new_id;
    CONTINUE WHEN new_id IS NULL;
    PERFORM job_enqueue('notification.deliver', jsonb_build_object('notificationId', new_id), new_id::text, target_school, now(), 6);
    queued := queued + 1;
  END LOOP;
  RETURN queued;
END
$$;
--> statement-breakpoint
-- Fan-out to every active administrator of a school (used for notices about
-- the school itself, such as platform support access).
CREATE OR REPLACE FUNCTION notification_queue_school_admins(
  target_school uuid, channels notification_channel[], template_name text, template_params jsonb, dedupe text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin_id uuid;
  total integer := 0;
BEGIN
  IF NOT (app_is_worker() OR app_is_platform_admin() OR (target_school = app_school_id() AND app_has_school_role('school_admin'))) THEN
    RAISE EXCEPTION 'not allowed to notify this school' USING ERRCODE = '42501';
  END IF;
  FOR admin_id IN
    SELECT m.user_id FROM school_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.school_id = target_school AND m.role = 'school_admin' AND m.status = 'active' AND u.status = 'active'
  LOOP
    total := total + notification_queue(admin_id, target_school, channels, template_name, template_params, dedupe);
  END LOOP;
  RETURN total;
END
$$;
--> statement-breakpoint
-- What the worker needs to deliver one notification, including the address.
CREATE OR REPLACE FUNCTION notification_for_delivery(notification_id uuid)
RETURNS TABLE (id uuid, channel notification_channel, template text, params jsonb, status notification_status,
               recipient_name text, recipient_email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may deliver notifications' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT n.id, n.channel, n.template, n.params, n.status, u.full_name, u.email
  FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE n.id = notification_id;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notification_mark(
  notification_id uuid, new_status notification_status, provider_name text, provider_reference text, error_text text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the worker may update deliveries' USING ERRCODE = '42501';
  END IF;
  UPDATE notifications SET status = new_status, provider = left(provider_name, 50), provider_ref = left(provider_reference, 200),
    last_error = left(error_text, 500),
    delivered_at = CASE WHEN new_status IN ('delivered', 'sandboxed') THEN now() ELSE delivered_at END
  WHERE id = notification_id AND status IN ('pending', 'failed');
  RETURN FOUND;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- idempotency
CREATE POLICY idempotency_own ON idempotency_records FOR ALL
  USING (actor_user_id = app_user_id())
  WITH CHECK (actor_user_id = app_user_id());
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
