alter table "public"."servers"
  add column if not exists "boot_status" text null;

alter table "public"."servers"
  add column if not exists "boot_status_detail" text null;
