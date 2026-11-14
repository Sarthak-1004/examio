CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_reset_idx" ON "rate_limit_buckets" USING btree ("reset_at");--> statement-breakpoint

-- =====================================================================
-- Phase 1, task 01.3: shared rate limiting.
-- Global infrastructure table: RLS is enabled with no policy and the
-- runtime role receives no table privileges (see TABLE_GRANTS in
-- scripts/setup-roles.ts). Access is only through the functions below.
-- Recovery: forward-fix; the table holds disposable counters and may be
-- emptied at any time.
-- =====================================================================
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Atomically counts one attempt in a fixed window. Call it outside the
-- business transaction, so a rolled-back failure is still counted.
CREATE OR REPLACE FUNCTION rate_limit_hit(bucket_key text, max_hits integer, window_seconds integer)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  hits integer;
  resets timestamptz;
BEGIN
  IF bucket_key IS NULL OR bucket_key !~ '^[0-9a-f]{64}$'
     OR max_hits IS NULL OR max_hits < 1
     OR window_seconds IS NULL OR window_seconds < 1 OR window_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid rate limit arguments' USING ERRCODE = '22023';
  END IF;

  INSERT INTO rate_limit_buckets AS b (key, count, reset_at)
  VALUES (bucket_key, 1, clock_timestamp() + make_interval(secs => window_seconds))
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN b.reset_at <= clock_timestamp() THEN 1 ELSE b.count + 1 END,
    reset_at = CASE WHEN b.reset_at <= clock_timestamp()
      THEN clock_timestamp() + make_interval(secs => window_seconds)
      ELSE b.reset_at END
  RETURNING b.count, b.reset_at INTO hits, resets;

  -- Opportunistic cleanup until a scheduled job exists (Phase 2).
  IF random() < 0.01 THEN
    DELETE FROM rate_limit_buckets r WHERE r.reset_at < clock_timestamp() - interval '1 hour';
  END IF;

  RETURN QUERY SELECT hits <= max_hits,
    greatest(0, ceil(extract(epoch FROM resets - clock_timestamp())))::integer;
END
$$;
--> statement-breakpoint
-- Gives back one counted attempt, so that only failures consume a limit.
-- It never clears a bucket: a success cannot erase earlier failures.
CREATE OR REPLACE FUNCTION rate_limit_refund(bucket_key text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE rate_limit_buckets SET count = count - 1
  WHERE key = bucket_key AND count > 0 AND reset_at > clock_timestamp()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rate_limit_hit(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rate_limit_refund(text) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examio_app') THEN
    GRANT EXECUTE ON FUNCTION rate_limit_hit(text, integer, integer) TO examio_app;
    GRANT EXECUTE ON FUNCTION rate_limit_refund(text) TO examio_app;
  END IF;
END
$$;
