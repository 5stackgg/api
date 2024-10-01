alter table "public"."servers" add column if not exists "region" text
 not null default 'Lan';

