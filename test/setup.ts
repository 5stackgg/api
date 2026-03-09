import { execSync } from "child_process";
import { seedTestDatabase } from "./seed";

export default async function () {
  console.log("\n[E2E Setup] Starting test containers...");

  try {
    execSync("docker compose -f test/docker-compose.test.yml up -d --wait", {
      stdio: "inherit",
    });
  } catch {
    console.error(
      "[E2E Setup] Failed to start containers. Ensure Docker is running.",
    );
    process.exit(1);
  }

  // Allow services to fully initialize
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Seed test data (tables must exist from migrations)
  try {
    await seedTestDatabase();
  } catch {
    console.warn("[E2E Setup] Seeding skipped (migrations may be pending).");
  }

  console.log("[E2E Setup] Test containers ready.");
}
