DROP TRIGGER IF EXISTS trigger_delete_old_file_operations ON "public"."file_operations_log";
DROP FUNCTION IF EXISTS delete_old_file_operations();
DROP INDEX IF EXISTS "public"."idx_file_operations_node_server";
DROP TABLE IF EXISTS "public"."file_operations_log";
