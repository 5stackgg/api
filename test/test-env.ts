// Test environment defaults — loaded via jest setupFiles before each test worker.
// Values are only set if not already present, so CI or local .env can override.

process.env.DEMOS_DOMAIN = process.env.DEMOS_DOMAIN || "localhost";
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "test-key";
process.env.S3_SECRET = process.env.S3_SECRET || "test-secret";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || "localhost";
process.env.S3_PORT = process.env.S3_PORT || "9000";

process.env.REDIS_HOST = process.env.REDIS_HOST || "localhost";
process.env.REDIS_SERVICE_PORT = process.env.REDIS_SERVICE_PORT || "6380";

process.env.HASURA_GRAPHQL_ENDPOINT =
  process.env.HASURA_GRAPHQL_ENDPOINT || "http://localhost:8080";
process.env.HASURA_GRAPHQL_ADMIN_SECRET =
  process.env.HASURA_GRAPHQL_ADMIN_SECRET || "test-secret";
