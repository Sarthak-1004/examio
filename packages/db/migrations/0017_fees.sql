CREATE TYPE "public"."adjustment_kind" AS ENUM('waiver', 'extra_charge', 'refund', 'receipt_reversal');
--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');
--> statement-breakpoint
CREATE TYPE "public"."concession_kind" AS ENUM('percent', 'amount');
--> statement-breakpoint
CREATE TYPE "public"."fee_structure_status" AS ENUM('draft', 'approved', 'archived');
--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('open', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('charge', 'late_fee', 'payment', 'adjustment', 'refund', 'reversal');
--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'cheque', 'bank_transfer', 'upi', 'online');
--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'captured', 'failed');
--> statement-breakpoint
CREATE TABLE "fee_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"kind" "adjustment_kind" NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"ledger_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_adjustments_amount" CHECK ("fee_adjustments"."amount_paise" between 1 and 100000000),
	CONSTRAINT "fee_adjustments_reason_length" CHECK (char_length("fee_adjustments"."reason") between 3 and 200),
	CONSTRAINT "fee_adjustments_payment" CHECK (("fee_adjustments"."kind" in ('refund', 'receipt_reversal')) = ("fee_adjustments"."payment_id" is not null)),
	CONSTRAINT "fee_adjustments_decision" CHECK (("fee_adjustments"."status" = 'pending') = ("fee_adjustments"."decided_at" is null) and ("fee_adjustments"."decided_at" is null) = ("fee_adjustments"."decided_by" is null) and ("fee_adjustments"."decided_by" is null or "fee_adjustments"."decided_by" <> "fee_adjustments"."requested_by") and (("fee_adjustments"."status" = 'approved') = ("fee_adjustments"."ledger_entry_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "fee_concessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"fee_head_id" uuid,
	"kind" "concession_kind" NOT NULL,
	"value" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_concessions_value" CHECK (("fee_concessions"."kind" = 'percent' and "fee_concessions"."value" between 1 and 10000) or ("fee_concessions"."kind" = 'amount' and "fee_concessions"."value" between 1 and 100000000)),
	CONSTRAINT "fee_concessions_reason_length" CHECK (char_length("fee_concessions"."reason") between 3 and 200),
	CONSTRAINT "fee_concessions_decision" CHECK (("fee_concessions"."status" = 'pending') = ("fee_concessions"."decided_at" is null) and ("fee_concessions"."decided_at" is null) = ("fee_concessions"."decided_by" is null) and ("fee_concessions"."decided_by" is null or "fee_concessions"."decided_by" <> "fee_concessions"."requested_by"))
);
--> statement-breakpoint
CREATE TABLE "fee_counters" (
	"school_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fee_counters_pk" PRIMARY KEY("school_id","kind"),
	CONSTRAINT "fee_counters_kind" CHECK ("fee_counters"."kind" in ('invoice', 'receipt'))
);
--> statement-breakpoint
CREATE TABLE "fee_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tax_bp" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_heads_name_length" CHECK (char_length("fee_heads"."name") between 1 and 80),
	CONSTRAINT "fee_heads_tax_bp" CHECK ("fee_heads"."tax_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "fee_structure_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"fee_head_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"due_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_structure_items_label_length" CHECK (char_length("fee_structure_items"."label") between 1 and 80),
	CONSTRAINT "fee_structure_items_amount" CHECK ("fee_structure_items"."amount_paise" between 1 and 100000000)
);
--> statement-breakpoint
CREATE TABLE "fee_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "fee_structure_status" DEFAULT 'draft' NOT NULL,
	"late_fee_paise" integer DEFAULT 0 NOT NULL,
	"late_grace_days" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_structures_name_length" CHECK (char_length("fee_structures"."name") between 1 and 80),
	CONSTRAINT "fee_structures_late_fee" CHECK ("fee_structures"."late_fee_paise" between 0 and 100000000 and "fee_structures"."late_grace_days" between 0 and 365),
	CONSTRAINT "fee_structures_approval" CHECK (("fee_structures"."status" = 'draft') = ("fee_structures"."approved_at" is null) and ("fee_structures"."approved_at" is null) = ("fee_structures"."approved_by" is null))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"fee_head_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer NOT NULL,
	CONSTRAINT "invoice_lines_amounts" CHECK ("invoice_lines"."amount_paise" >= 0 and "invoice_lines"."discount_paise" between 0 and "invoice_lines"."amount_paise" and "invoice_lines"."tax_paise" >= 0 and "invoice_lines"."total_paise" = "invoice_lines"."amount_paise" - "invoice_lines"."discount_paise" + "invoice_lines"."tax_paise")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"number" text NOT NULL,
	"due_on" date NOT NULL,
	"total_paise" integer NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "invoices_total" CHECK ("invoices"."total_paise" >= 0),
	CONSTRAINT "invoices_cancelled" CHECK (("invoices"."status" = 'cancelled') = ("invoices"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"kind" "ledger_kind" NOT NULL,
	"amount_paise" integer NOT NULL,
	"reverses_entry_id" uuid,
	"memo" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_nonzero" CHECK ("ledger_entries"."amount_paise" <> 0),
	CONSTRAINT "ledger_entries_sign" CHECK (("ledger_entries"."kind" in ('charge', 'late_fee', 'refund') and "ledger_entries"."amount_paise" > 0) or ("ledger_entries"."kind" = 'payment' and "ledger_entries"."amount_paise" < 0) or "ledger_entries"."kind" in ('adjustment', 'reversal')),
	CONSTRAINT "ledger_entries_reversal" CHECK (("ledger_entries"."kind" = 'reversal') = ("ledger_entries"."reverses_entry_id" is not null)),
	CONSTRAINT "ledger_entries_memo_length" CHECK ("ledger_entries"."memo" is null or char_length("ledger_entries"."memo") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payment_id" uuid,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" "payment_status" NOT NULL,
	"provider" text,
	"provider_order_id" text,
	"provider_payment_id" text,
	"reference" text,
	"receipt_no" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"failure_reason" text,
	CONSTRAINT "payments_amount" CHECK ("payments"."amount_paise" between 1 and 100000000),
	CONSTRAINT "payments_online" CHECK (("payments"."method" = 'online') = ("payments"."provider" is not null and "payments"."provider_order_id" is not null)),
	CONSTRAINT "payments_captured" CHECK (("payments"."status" = 'captured') = ("payments"."captured_at" is not null and "payments"."receipt_no" is not null)),
	CONSTRAINT "payments_reference_length" CHECK ("payments"."reference" is null or char_length("payments"."reference") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_counters" ADD CONSTRAINT "fee_counters_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "fee_adjustments_status_idx" ON "fee_adjustments" USING btree ("school_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "fee_adjustments_one_open_payment_reversal" ON "fee_adjustments" USING btree ("payment_id") WHERE "fee_adjustments"."kind" in ('refund', 'receipt_reversal') and "fee_adjustments"."status" <> 'rejected';
--> statement-breakpoint
CREATE INDEX "fee_concessions_student_idx" ON "fee_concessions" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fee_heads_school_id_unique" ON "fee_heads" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fee_heads_school_name_unique" ON "fee_heads" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE INDEX "fee_structure_items_structure_idx" ON "fee_structure_items" USING btree ("school_id","structure_id","due_on");
--> statement-breakpoint
CREATE UNIQUE INDEX "fee_structures_school_id_unique" ON "fee_structures" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fee_structures_school_year_class_name_unique" ON "fee_structures" USING btree ("school_id","academic_year_id","class_id",lower("name"));
--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("school_id","invoice_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_school_id_unique" ON "invoices" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_school_id_student_unique" ON "invoices" USING btree ("school_id","id","student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_school_number_unique" ON "invoices" USING btree ("school_id","number");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_per_instalment" ON "invoices" USING btree ("school_id","structure_id","student_id","due_on");
--> statement-breakpoint
CREATE INDEX "invoices_student_idx" ON "invoices" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE INDEX "invoices_due_idx" ON "invoices" USING btree ("school_id","due_on");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_school_id_unique" ON "ledger_entries" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_reversal" ON "ledger_entries" USING btree ("reverses_entry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_payment_credit" ON "ledger_entries" USING btree ("payment_id") WHERE "ledger_entries"."kind" = 'payment';
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_late_fee" ON "ledger_entries" USING btree ("invoice_id") WHERE "ledger_entries"."kind" = 'late_fee';
--> statement-breakpoint
CREATE INDEX "ledger_entries_student_idx" ON "ledger_entries" USING btree ("school_id","student_id","created_at");
--> statement-breakpoint
CREATE INDEX "ledger_entries_invoice_idx" ON "ledger_entries" USING btree ("school_id","invoice_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" USING btree ("provider","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_school_id_unique" ON "payments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_unique" ON "payments" USING btree ("provider","provider_order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_unique" ON "payments" USING btree ("provider","provider_payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_school_receipt_unique" ON "payments" USING btree ("school_id","receipt_no");
--> statement-breakpoint
CREATE INDEX "payments_student_idx" ON "payments" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE INDEX "payments_captured_idx" ON "payments" USING btree ("school_id","captured_at");
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_invoice_fk" FOREIGN KEY ("school_id","invoice_id") REFERENCES "public"."invoices"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_payment_fk" FOREIGN KEY ("school_id","payment_id") REFERENCES "public"."payments"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_ledger_fk" FOREIGN KEY ("school_id","ledger_entry_id") REFERENCES "public"."ledger_entries"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_head_fk" FOREIGN KEY ("school_id","fee_head_id") REFERENCES "public"."fee_heads"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_structure_fk" FOREIGN KEY ("school_id","structure_id") REFERENCES "public"."fee_structures"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_head_fk" FOREIGN KEY ("school_id","fee_head_id") REFERENCES "public"."fee_heads"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_year_fk" FOREIGN KEY ("school_id","academic_year_id") REFERENCES "public"."academic_years"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_class_fk" FOREIGN KEY ("school_id","class_id") REFERENCES "public"."classes"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("school_id","invoice_id") REFERENCES "public"."invoices"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_head_fk" FOREIGN KEY ("school_id","fee_head_id") REFERENCES "public"."fee_heads"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_structure_fk" FOREIGN KEY ("school_id","structure_id") REFERENCES "public"."fee_structures"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_invoice_fk" FOREIGN KEY ("school_id","invoice_id") REFERENCES "public"."invoices"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_fk" FOREIGN KEY ("school_id","payment_id") REFERENCES "public"."payments"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_fk" FOREIGN KEY ("school_id","reverses_entry_id") REFERENCES "public"."ledger_entries"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("school_id","invoice_id","student_id") REFERENCES "public"."invoices"("school_id","id","student_id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 8: fees, invoices, payments and the student ledger (INR, integer paise).
--
-- Finance data is read and written by the school's administrators and finance staff; a parent
-- reads the invoices, payments and ledger of children with an active guardian link and may only
-- create a pending online payment for such an invoice. The ledger is append-only (insert and
-- select grants only). Concessions and adjustments are decided by a school administrator other
-- than the requester. An approved fee structure's items are fixed.
--
-- Online payments become captured only through payment_record_provider_event(), which runs in
-- the worker context after the webhook signature has been verified: each provider event is
-- processed once, a payment is credited once, a mismatched amount is never credited, and a
-- failure arriving after a capture is ignored.
--
-- Recovery: forward-fix.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_can_finance(target_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT target_school = app_school_id() AND (app_has_school_role('school_admin') OR app_has_school_role('finance'))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_fee_structure_draft(target_structure uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fee_structures s WHERE s.id = target_structure AND s.status = 'draft')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_can_see_invoice(target_invoice uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM invoices i WHERE i.id = target_invoice AND (app_can_finance(i.school_id) OR (i.school_id = app_school_id() AND app_is_guardian_of(i.student_id)))
  )
$$;
--> statement-breakpoint

-- Next invoice or receipt number of a school ("INV-000001", "RCT-000001"), gap-free per school.
CREATE OR REPLACE FUNCTION app_next_fee_number(target_school uuid, counter text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF NOT (app_can_finance(target_school) OR app_is_worker()) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO fee_counters AS c (school_id, kind, value) VALUES (target_school, counter, 1)
  ON CONFLICT (school_id, kind) DO UPDATE SET value = c.value + 1
  RETURNING value INTO n;
  RETURN (CASE counter WHEN 'invoice' THEN 'INV-' ELSE 'RCT-' END) || lpad(n::text, 6, '0');
END
$$;
--> statement-breakpoint

-- Applies one verified provider event. Returns the outcome; never raises for business outcomes.
CREATE OR REPLACE FUNCTION payment_record_provider_event(
  p_provider text, p_event_id text, p_event_type text, p_order_id text, p_payment_id text, p_status text, p_amount integer, p_failure text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev uuid;
  pay payments%ROWTYPE;
  result text;
BEGIN
  IF NOT app_is_worker() THEN
    RAISE EXCEPTION 'only the payment webhook may record provider events' USING ERRCODE = '42501';
  END IF;
  INSERT INTO payment_events (provider, event_id, event_type, outcome)
  VALUES (p_provider, p_event_id, left(p_event_type, 60), 'processing')
  ON CONFLICT (provider, event_id) DO NOTHING
  RETURNING id INTO ev;
  IF ev IS NULL THEN
    RETURN 'duplicate_event';
  END IF;

  SELECT * INTO pay FROM payments WHERE provider = p_provider AND provider_order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    result := 'unknown_order';
  ELSIF p_status = 'captured' THEN
    IF pay.status = 'captured' THEN
      result := CASE WHEN pay.provider_payment_id = p_payment_id THEN 'already_captured' ELSE 'second_capture_for_order' END;
    ELSIF p_amount IS DISTINCT FROM pay.amount_paise THEN
      result := 'amount_mismatch';
    ELSE
      UPDATE payments SET status = 'captured', provider_payment_id = p_payment_id, captured_at = now(),
        receipt_no = app_next_fee_number(pay.school_id, 'receipt'), failure_reason = NULL
      WHERE id = pay.id;
      INSERT INTO ledger_entries (school_id, student_id, invoice_id, payment_id, kind, amount_paise, memo)
      VALUES (pay.school_id, pay.student_id, pay.invoice_id, pay.id, 'payment', -pay.amount_paise, 'Online payment');
      INSERT INTO audit_events (school_id, actor_user_id, action, entity_type, entity_id, data)
      VALUES (pay.school_id, NULL, 'fees.payment_captured', 'payment', pay.id::text, jsonb_build_object('provider', p_provider, 'amountPaise', pay.amount_paise));
      result := 'captured';
    END IF;
  ELSIF p_status = 'failed' THEN
    IF pay.status = 'pending' THEN
      UPDATE payments SET status = 'failed', failure_reason = left(coalesce(p_failure, 'Payment failed'), 200) WHERE id = pay.id;
      result := 'failed';
    ELSE
      result := 'ignored_' || pay.status::text;
    END IF;
  ELSE
    result := 'ignored_event';
  END IF;

  UPDATE payment_events SET outcome = result, payment_id = pay.id WHERE id = ev;
  RETURN result;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- setup tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_heads', 'fee_structures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_can_finance(school_id) OR app_has_support_access(school_id))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_can_finance(school_id))', t || '_insert', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY fee_heads_update ON fee_heads FOR UPDATE USING (app_can_finance(school_id)) WITH CHECK (app_can_finance(school_id));
--> statement-breakpoint
-- Drafts are edited by finance; approval and archiving are for school administrators.
CREATE POLICY fee_structures_update ON fee_structures FOR UPDATE
  USING (app_can_finance(school_id) AND (status = 'draft' OR app_has_school_role('school_admin')))
  WITH CHECK (app_can_finance(school_id) AND (status = 'draft' OR (app_has_school_role('school_admin') AND approved_by IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE fee_structure_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY fee_structure_items_select ON fee_structure_items FOR SELECT USING (app_can_finance(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY fee_structure_items_insert ON fee_structure_items FOR INSERT WITH CHECK (app_can_finance(school_id) AND app_fee_structure_draft(structure_id));
--> statement-breakpoint
CREATE POLICY fee_structure_items_delete ON fee_structure_items FOR DELETE USING (app_can_finance(school_id) AND app_fee_structure_draft(structure_id));
--> statement-breakpoint

-- ---------------------------------------------------------------- approvals
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_concessions', 'fee_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_can_finance(school_id) OR app_has_support_access(school_id))', t || '_select', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_can_finance(school_id) AND requested_by = app_user_id() AND status = 'pending')$p$, t || '_insert', t);
    -- A school administrator decides; never their own request (also a CHECK constraint).
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE
      USING (app_can_finance(school_id) AND app_has_school_role('school_admin') AND status = 'pending' AND requested_by <> app_user_id())
      WITH CHECK (decided_by = app_user_id())$p$, t || '_decide', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- An approved concession can be revoked by finance (it then stops applying to new invoices).
CREATE POLICY fee_concessions_revoke ON fee_concessions FOR UPDATE
  USING (app_can_finance(school_id) AND status = 'approved' AND revoked_at IS NULL)
  WITH CHECK (status = 'approved' AND revoked_at IS NOT NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------- invoices, payments, ledger
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (app_can_finance(school_id) OR (school_id = app_school_id() AND app_is_guardian_of(student_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY invoices_insert ON invoices FOR INSERT WITH CHECK (app_can_finance(school_id) AND issued_by = app_user_id());
--> statement-breakpoint
CREATE POLICY invoices_update ON invoices FOR UPDATE USING (app_can_finance(school_id)) WITH CHECK (app_can_finance(school_id));
--> statement-breakpoint
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_lines_select ON invoice_lines FOR SELECT USING (app_can_see_invoice(invoice_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY invoice_lines_insert ON invoice_lines FOR INSERT WITH CHECK (app_can_finance(school_id));
--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payments_select ON payments FOR SELECT
  USING (app_can_finance(school_id) OR (school_id = app_school_id() AND app_is_guardian_of(student_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
-- Finance records offline payments as captured; a parent may only open a pending online payment.
CREATE POLICY payments_insert ON payments FOR INSERT
  WITH CHECK (created_by = app_user_id() AND (
    (app_can_finance(school_id) AND method <> 'online' AND status = 'captured')
    OR (school_id = app_school_id() AND app_is_guardian_of(student_id) AND method = 'online' AND status = 'pending' AND provider_payment_id IS NULL)
  ));
--> statement-breakpoint
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ledger_entries_select ON ledger_entries FOR SELECT
  USING (app_can_finance(school_id) OR (school_id = app_school_id() AND app_is_guardian_of(student_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY ledger_entries_insert ON ledger_entries FOR INSERT WITH CHECK (app_can_finance(school_id) AND created_by = app_user_id());
--> statement-breakpoint
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fee_counters ENABLE ROW LEVEL SECURITY;
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
