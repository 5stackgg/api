import { execSync } from "child_process";

export default async function () {
  console.log("\n[E2E Teardown] Stopping test containers...");

  try {
    execSync("docker compose -f test/docker-compose.test.yml down -v", {
      stdio: "inherit",
    });
  } catch {
    console.warn(
      "[E2E Teardown] Failed to stop containers. They may need manual cleanup.",
    );
  }

  console.log("[E2E Teardown] Cleanup complete.");
}
