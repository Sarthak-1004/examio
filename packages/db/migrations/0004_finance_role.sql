-- Phase 1, task 01.5: add the finance staff role so capability checks cover it.
-- The role grants no privileges by itself: existing policies give it only what any
-- member has (own identity, own membership, own school). Finance capabilities arrive
-- with the fees module (Phase 8).
-- Recovery: PostgreSQL cannot drop an enum value. The value is harmless when unused;
-- revoke any memberships that hold it instead.
ALTER TYPE "public"."membership_role" ADD VALUE 'finance';
