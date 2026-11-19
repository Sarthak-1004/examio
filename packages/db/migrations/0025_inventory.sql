CREATE TYPE "public"."inventory_asset_event_kind" AS ENUM('added', 'moved', 'allocated', 'returned', 'repair', 'repaired', 'disposed');
--> statement-breakpoint
CREATE TYPE "public"."inventory_asset_status" AS ENUM('in_store', 'allocated', 'under_repair', 'disposed');
--> statement-breakpoint
CREATE TYPE "public"."inventory_item_kind" AS ENUM('asset', 'consumable');
--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_kind" AS ENUM('received', 'issued', 'transfer_out', 'transfer_in', 'adjusted');
--> statement-breakpoint
CREATE TABLE "inventory_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"allocated_by" uuid NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_on" date,
	"returned_by" uuid,
	"returned_at" timestamp with time zone,
	"return_note" text,
	CONSTRAINT "inventory_allocations_returned" CHECK (("inventory_allocations"."returned_at" is null) = ("inventory_allocations"."returned_by" is null) and ("inventory_allocations"."return_note" is null or char_length("inventory_allocations"."return_note") <= 300))
);
--> statement-breakpoint
CREATE TABLE "inventory_asset_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "inventory_asset_event_kind" NOT NULL,
	"location_id" uuid,
	"staff_id" uuid,
	"note" text,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "inventory_asset_events_note" CHECK (("inventory_asset_events"."note" is null or char_length("inventory_asset_events"."note") <= 300) and ("inventory_asset_events"."kind" <> 'disposed' or "inventory_asset_events"."note" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_kind" "inventory_item_kind" DEFAULT 'asset' NOT NULL,
	"tag" text NOT NULL,
	"serial_no" text,
	"location_id" uuid NOT NULL,
	"status" "inventory_asset_status" DEFAULT 'in_store' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_assets_kind" CHECK ("inventory_assets"."item_kind" = 'asset'),
	CONSTRAINT "inventory_assets_text" CHECK ("inventory_assets"."tag" ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,29}$' and ("inventory_assets"."serial_no" is null or char_length("inventory_assets"."serial_no") <= 60) and ("inventory_assets"."note" is null or char_length("inventory_assets"."note") <= 300))
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "inventory_item_kind" NOT NULL,
	"category" text,
	"unit" text,
	"reorder_level" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "inventory_items_text" CHECK (char_length("inventory_items"."name") between 1 and 120 and ("inventory_items"."category" is null or char_length("inventory_items"."category") <= 80) and ("inventory_items"."unit" is null or char_length("inventory_items"."unit") <= 30)),
	CONSTRAINT "inventory_items_consumable" CHECK (("inventory_items"."kind" = 'consumable') or ("inventory_items"."unit" is null and "inventory_items"."reorder_level" is null)),
	CONSTRAINT "inventory_items_reorder" CHECK ("inventory_items"."reorder_level" is null or "inventory_items"."reorder_level" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_locations_name" CHECK (char_length("inventory_locations"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" "inventory_movement_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"staff_id" uuid,
	"other_location_id" uuid,
	"note" text,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "inventory_movements_values" CHECK ("inventory_movements"."quantity" <> 0 and "inventory_movements"."balance_after" >= 0 and ("inventory_movements"."note" is null or char_length("inventory_movements"."note") <= 300)),
	CONSTRAINT "inventory_movements_sign" CHECK (("inventory_movements"."kind" in ('received', 'transfer_in') and "inventory_movements"."quantity" > 0) or ("inventory_movements"."kind" in ('issued', 'transfer_out') and "inventory_movements"."quantity" < 0) or ("inventory_movements"."kind" = 'adjusted' and "inventory_movements"."note" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_stock" (
	"school_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_kind" "inventory_item_kind" DEFAULT 'consumable' NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_item_id_location_id_pk" PRIMARY KEY("item_id","location_id"),
	CONSTRAINT "inventory_stock_kind" CHECK ("inventory_stock"."item_kind" = 'consumable'),
	CONSTRAINT "inventory_stock_not_negative" CHECK ("inventory_stock"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_allocated_by_users_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_asset_events" ADD CONSTRAINT "inventory_asset_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_asset_events" ADD CONSTRAINT "inventory_asset_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_assets" ADD CONSTRAINT "inventory_assets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stock_fk" FOREIGN KEY ("item_id","location_id") REFERENCES "public"."inventory_stock"("item_id","location_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_allocations_school_id_unique" ON "inventory_allocations" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_allocations_one_open_per_asset" ON "inventory_allocations" USING btree ("asset_id") WHERE "inventory_allocations"."returned_at" is null;
--> statement-breakpoint
CREATE INDEX "inventory_allocations_staff_idx" ON "inventory_allocations" USING btree ("school_id","staff_id");
--> statement-breakpoint
CREATE INDEX "inventory_asset_events_asset_idx" ON "inventory_asset_events" USING btree ("asset_id","at");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_assets_school_id_unique" ON "inventory_assets" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_assets_tag_unique" ON "inventory_assets" USING btree ("school_id",lower("tag"));
--> statement-breakpoint
CREATE INDEX "inventory_assets_item_idx" ON "inventory_assets" USING btree ("item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_school_id_unique" ON "inventory_items" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_school_kind_unique" ON "inventory_items" USING btree ("school_id","id","kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_name_unique" ON "inventory_items" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_school_id_unique" ON "inventory_locations" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_name_unique" ON "inventory_locations" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" USING btree ("item_id","at");
--> statement-breakpoint
CREATE INDEX "inventory_stock_school_idx" ON "inventory_stock" USING btree ("school_id");
--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_asset_fk" FOREIGN KEY ("school_id","asset_id") REFERENCES "public"."inventory_assets"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_allocations" ADD CONSTRAINT "inventory_allocations_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_asset_events" ADD CONSTRAINT "inventory_asset_events_asset_fk" FOREIGN KEY ("school_id","asset_id") REFERENCES "public"."inventory_assets"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_asset_events" ADD CONSTRAINT "inventory_asset_events_location_fk" FOREIGN KEY ("school_id","location_id") REFERENCES "public"."inventory_locations"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_asset_events" ADD CONSTRAINT "inventory_asset_events_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_assets" ADD CONSTRAINT "inventory_assets_item_fk" FOREIGN KEY ("school_id","item_id","item_kind") REFERENCES "public"."inventory_items"("school_id","id","kind") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_assets" ADD CONSTRAINT "inventory_assets_location_fk" FOREIGN KEY ("school_id","location_id") REFERENCES "public"."inventory_locations"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_fk" FOREIGN KEY ("school_id","item_id") REFERENCES "public"."inventory_items"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_other_location_fk" FOREIGN KEY ("school_id","other_location_id") REFERENCES "public"."inventory_locations"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_item_fk" FOREIGN KEY ("school_id","item_id","item_kind") REFERENCES "public"."inventory_items"("school_id","id","kind") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_stock" ADD CONSTRAINT "inventory_stock_location_fk" FOREIGN KEY ("school_id","location_id") REFERENCES "public"."inventory_locations"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 13.3: inventory.
--
-- School administrators only (and platform support with an active grant, read only).
-- Locations; items that are assets (tracked by tag) or consumables (counted per location).
-- inventory_stock.quantity can never be negative (check constraint), so issuing or
-- transferring more than is there fails in the database. One open allocation per asset
-- (unique index inventory_allocations_one_open_per_asset). inventory_movements and
-- inventory_asset_events are append-only (no update or delete grant, no update policy).
-- A disposed asset can no longer change (trigger inventory_assets_guard).
--
-- Recovery: forward-fix.
-- =====================================================================

CREATE OR REPLACE FUNCTION inventory_assets_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'disposed' THEN
    RAISE EXCEPTION 'A disposed asset cannot change.' USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_assets_disposed_final';
  END IF;
  IF NEW.item_id <> OLD.item_id OR NEW.tag <> OLD.tag THEN
    RAISE EXCEPTION 'An asset keeps its item and tag.' USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_assets_identity';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_assets_guard BEFORE UPDATE ON inventory_assets FOR EACH ROW EXECUTE FUNCTION inventory_assets_guard();
--> statement-breakpoint

ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_locations_select ON inventory_locations FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_locations_insert ON inventory_locations FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY inventory_locations_update ON inventory_locations FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_items_select ON inventory_items FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_items_insert ON inventory_items FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id());
--> statement-breakpoint
CREATE POLICY inventory_items_update ON inventory_items FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE inventory_assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_assets_select ON inventory_assets FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_assets_insert ON inventory_assets FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND status = 'in_store');
--> statement-breakpoint
CREATE POLICY inventory_assets_update ON inventory_assets FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE inventory_allocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_allocations_select ON inventory_allocations FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_allocations_insert ON inventory_allocations FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND allocated_by = app_user_id() AND returned_at IS NULL);
--> statement-breakpoint
CREATE POLICY inventory_allocations_update ON inventory_allocations FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id) AND returned_at IS NULL)
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND returned_by = app_user_id());
--> statement-breakpoint
ALTER TABLE inventory_stock ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_stock_select ON inventory_stock FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_stock_insert ON inventory_stock FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY inventory_stock_update ON inventory_stock FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_movements_select ON inventory_movements FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_movements_insert ON inventory_movements FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND actor_user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE inventory_asset_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY inventory_asset_events_select ON inventory_asset_events FOR SELECT
  USING ((school_id = app_school_id() AND app_can_manage_setup(school_id)) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY inventory_asset_events_insert ON inventory_asset_events FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND actor_user_id = app_user_id());
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
