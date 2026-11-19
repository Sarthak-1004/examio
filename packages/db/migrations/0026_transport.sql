CREATE TABLE "transport_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"stop_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ended_on" date,
	"created_by" uuid NOT NULL,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_assignments_dates" CHECK (("transport_assignments"."ended_on" is null) = ("transport_assignments"."ended_by" is null) and ("transport_assignments"."ended_on" is null or "transport_assignments"."ended_on" >= "transport_assignments"."starts_on"))
);
--> statement-breakpoint
CREATE TABLE "transport_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vehicle_id" uuid,
	"driver_staff_id" uuid,
	"attendant_staff_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_routes_values" CHECK (char_length("transport_routes"."name") between 1 and 80 and ("transport_routes"."driver_staff_id" is null or "transport_routes"."attendant_staff_id" is null or "transport_routes"."driver_staff_id" <> "transport_routes"."attendant_staff_id"))
);
--> statement-breakpoint
CREATE TABLE "transport_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sequence" integer NOT NULL,
	"pickup_minute" integer,
	"drop_minute" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_stops_values" CHECK (char_length("transport_stops"."name") between 1 and 80 and "transport_stops"."sequence" between 1 and 99 and ("transport_stops"."pickup_minute" is null or "transport_stops"."pickup_minute" between 0 and 1439) and ("transport_stops"."drop_minute" is null or "transport_stops"."drop_minute" between 0 and 1439))
);
--> statement-breakpoint
CREATE TABLE "transport_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"registration_no" text NOT NULL,
	"capacity" integer NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_vehicles_values" CHECK ("transport_vehicles"."registration_no" ~ '^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$' and "transport_vehicles"."capacity" between 1 and 100 and ("transport_vehicles"."description" is null or char_length("transport_vehicles"."description") <= 120))
);
--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_vehicles" ADD CONSTRAINT "transport_vehicles_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_assignments_school_id_unique" ON "transport_assignments" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_assignments_one_active_per_student" ON "transport_assignments" USING btree ("student_id") WHERE "transport_assignments"."ended_on" is null;
--> statement-breakpoint
CREATE INDEX "transport_assignments_route_idx" ON "transport_assignments" USING btree ("route_id") WHERE "transport_assignments"."ended_on" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_routes_school_id_unique" ON "transport_routes" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_routes_name_unique" ON "transport_routes" USING btree ("school_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_stops_school_id_unique" ON "transport_stops" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_stops_route_stop_unique" ON "transport_stops" USING btree ("school_id","route_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_stops_sequence_unique" ON "transport_stops" USING btree ("route_id","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_stops_name_unique" ON "transport_stops" USING btree ("route_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_vehicles_school_id_unique" ON "transport_vehicles" USING btree ("school_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_vehicles_registration_unique" ON "transport_vehicles" USING btree ("school_id",lower("registration_no"));
--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."student_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_stop_fk" FOREIGN KEY ("school_id","route_id","stop_id") REFERENCES "public"."transport_stops"("school_id","route_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_vehicle_fk" FOREIGN KEY ("school_id","vehicle_id") REFERENCES "public"."transport_vehicles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_driver_fk" FOREIGN KEY ("school_id","driver_staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_attendant_fk" FOREIGN KEY ("school_id","attendant_staff_id") REFERENCES "public"."staff_profiles"("school_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_route_fk" FOREIGN KEY ("school_id","route_id") REFERENCES "public"."transport_routes"("school_id","id") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint

-- =====================================================================
-- Phase 13.4: transport.
--
-- Vehicles, routes and stops are readable by the school's members and written by school
-- administrators. Assignments are readable by administrators, the student and the student's
-- linked parents. One active assignment per student (unique index). Capacity is enforced here:
--   * transport_assignments_capacity (before insert): locks the route row, then counts the
--     route's active assignments against its vehicle's capacity (a route without a vehicle or an
--     archived route takes no students);
--   * transport_routes_guard (before update): a vehicle change or archiving must still fit the
--     students already on the route;
--   * transport_vehicles_guard (before update): lowering capacity or archiving locks the routes
--     using the vehicle and checks their occupancy.
-- Each check takes the route lock before counting in a new statement, so concurrent assignments
-- and capacity changes are serialised per route.
--
-- Recovery: forward-fix.
-- =====================================================================

CREATE OR REPLACE FUNCTION transport_route_occupancy(target_route uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT count(*)::int FROM transport_assignments WHERE route_id = target_route AND ended_on IS NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transport_assignments_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  cap integer;
  archived timestamptz;
BEGIN
  IF NEW.ended_on IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM transport_routes WHERE id = NEW.route_id FOR UPDATE;
  SELECT v.capacity, r.archived_at INTO cap, archived
    FROM transport_routes r LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id AND v.archived_at IS NULL
   WHERE r.id = NEW.route_id;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'This route is archived.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_route_archived';
  END IF;
  IF cap IS NULL THEN
    RAISE EXCEPTION 'This route has no vehicle.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_route_no_vehicle';
  END IF;
  IF transport_route_occupancy(NEW.route_id) >= cap THEN
    RAISE EXCEPTION 'This route is full.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_capacity';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transport_assignments_capacity BEFORE INSERT ON transport_assignments FOR EACH ROW EXECUTE FUNCTION transport_assignments_capacity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transport_routes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  taken integer;
  cap integer;
BEGIN
  IF NEW.vehicle_id IS NOT DISTINCT FROM OLD.vehicle_id AND (NEW.archived_at IS NULL OR OLD.archived_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  taken := transport_route_occupancy(NEW.id);
  IF taken = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Students are still on this route.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_route_in_use';
  END IF;
  SELECT capacity INTO cap FROM transport_vehicles WHERE id = NEW.vehicle_id AND archived_at IS NULL;
  IF cap IS NULL OR cap < taken THEN
    RAISE EXCEPTION 'The students on this route would not fit.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_capacity';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transport_routes_guard BEFORE UPDATE ON transport_routes FOR EACH ROW EXECUTE FUNCTION transport_routes_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transport_vehicles_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  worst integer;
BEGIN
  IF NEW.capacity >= OLD.capacity AND (NEW.archived_at IS NULL OR OLD.archived_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM transport_routes WHERE vehicle_id = NEW.id AND archived_at IS NULL ORDER BY id FOR UPDATE;
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM transport_routes WHERE vehicle_id = NEW.id AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'A route still uses this vehicle.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_vehicle_in_use';
    END IF;
    RETURN NEW;
  END IF;
  SELECT max(transport_route_occupancy(id)) INTO worst FROM transport_routes WHERE vehicle_id = NEW.id AND archived_at IS NULL;
  IF coalesce(worst, 0) > NEW.capacity THEN
    RAISE EXCEPTION 'A route using this vehicle has more students than that.' USING ERRCODE = 'check_violation', CONSTRAINT = 'transport_capacity';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER transport_vehicles_guard BEFORE UPDATE ON transport_vehicles FOR EACH ROW EXECUTE FUNCTION transport_vehicles_guard();
--> statement-breakpoint

ALTER TABLE transport_vehicles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_vehicles_select ON transport_vehicles FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY transport_vehicles_insert ON transport_vehicles FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY transport_vehicles_update ON transport_vehicles FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE transport_routes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_routes_select ON transport_routes FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY transport_routes_insert ON transport_routes FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY transport_routes_update ON transport_routes FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE transport_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_stops_select ON transport_stops FOR SELECT USING (app_can_read_school(school_id) OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY transport_stops_insert ON transport_stops FOR INSERT WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
CREATE POLICY transport_stops_update ON transport_stops FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id)) WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id));
--> statement-breakpoint
ALTER TABLE transport_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_assignments_select ON transport_assignments FOR SELECT
  USING ((school_id = app_school_id() AND (app_can_manage_setup(school_id) OR app_is_student_self(student_id) OR app_is_guardian_of(student_id)))
         OR app_has_support_access(school_id));
--> statement-breakpoint
CREATE POLICY transport_assignments_insert ON transport_assignments FOR INSERT
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND created_by = app_user_id() AND ended_on IS NULL);
--> statement-breakpoint
CREATE POLICY transport_assignments_update ON transport_assignments FOR UPDATE
  USING (school_id = app_school_id() AND app_can_manage_setup(school_id) AND ended_on IS NULL)
  WITH CHECK (school_id = app_school_id() AND app_can_manage_setup(school_id) AND ended_by = app_user_id());
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
