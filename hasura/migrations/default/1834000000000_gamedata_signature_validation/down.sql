DROP INDEX IF EXISTS "public"."gamedata_signature_validations_build_branch_idx";

ALTER TABLE "public"."gamedata_signature_validations"
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_build_id_fkey";

DROP TABLE "public"."gamedata_signature_validations";
