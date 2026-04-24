alter table "public"."servers"
  drop column if exists "boot_status_detail";

alter table "public"."servers"
  drop column if exists "boot_status";
