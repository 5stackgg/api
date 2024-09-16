DROP FUNCTION IF EXISTS public.match_cancels_at(match public.matches);

alter table "public"."matches" add column if not exists "cancels_at" timestamptz
 null;
