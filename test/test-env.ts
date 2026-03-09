// Test environment defaults — loaded via jest setupFiles before each test worker.
// Values are only set if not already present, so CI or local .env can override.

// App config
process.env.APP_KEY = process.env.APP_KEY || "test-app-key-for-e2e-tests";
process.env.ENC_SECRET = process.env.ENC_SECRET || "test-enc-secret-32chars!!!!!!!!";
process.env.WS_DOMAIN = process.env.WS_DOMAIN || "localhost";
process.env.WEB_DOMAIN = process.env.WEB_DOMAIN || "localhost";
process.env.API_DOMAIN = process.env.API_DOMAIN || "localhost";
process.env.RELAY_DOMAIN = process.env.RELAY_DOMAIN || "localhost";
process.env.DEMOS_DOMAIN = process.env.DEMOS_DOMAIN || "localhost";

// Postgres — matches test/docker-compose.test.yml
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || "localhost";
process.env.POSTGRES_SERVICE_PORT = process.env.POSTGRES_SERVICE_PORT || "5433";
process.env.POSTGRES_DB = process.env.POSTGRES_DB || "hasura_test";
process.env.POSTGRES_USER = process.env.POSTGRES_USER || "hasura";
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "test_password";

// Redis — matches test/docker-compose.test.yml
process.env.REDIS_HOST = process.env.REDIS_HOST || "localhost";
process.env.REDIS_SERVICE_PORT = process.env.REDIS_SERVICE_PORT || "6380";

// Hasura (mocked in tests, but config must be valid)
process.env.HASURA_GRAPHQL_ENDPOINT =
  process.env.HASURA_GRAPHQL_ENDPOINT || "http://localhost:8080";
process.env.HASURA_GRAPHQL_ADMIN_SECRET =
  process.env.HASURA_GRAPHQL_ADMIN_SECRET || "test-secret";

// S3/MinIO
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "test-key";
process.env.S3_SECRET = process.env.S3_SECRET || "test-secret";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || "localhost";
process.env.S3_PORT = process.env.S3_PORT || "9000";

// Steam (dummy values — no real Steam calls in tests)
process.env.STEAM_WEB_API_KEY =
  process.env.STEAM_WEB_API_KEY || "test-steam-key";
process.env.STEAM_USER = process.env.STEAM_USER || "test-steam-user";
process.env.STEAM_PASSWORD = process.env.STEAM_PASSWORD || "test-steam-password";

// Discord (empty token causes DiscordBotService.setup() to skip)
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
process.env.DISCORD_CLIENT_ID =
  process.env.DISCORD_CLIENT_ID || "test-discord-client-id";
process.env.DISCORD_CLIENT_SECRET =
  process.env.DISCORD_CLIENT_SECRET || "test-discord-secret";

// Tailscale (dummy values)
process.env.TAILSCALE_CLIENT_ID =
  process.env.TAILSCALE_CLIENT_ID || "test-tailscale-id";
process.env.TAILSCALE_SECRET_ID =
  process.env.TAILSCALE_SECRET_ID || "test-tailscale-secret";

// Typesense (mocked in tests)
process.env.TYPESENSE_API_KEY =
  process.env.TYPESENSE_API_KEY || "test-typesense-key";
