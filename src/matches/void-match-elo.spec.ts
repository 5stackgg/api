jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { DelayedError, Job } from "bullmq";
import { RecomputeAllElo } from "./jobs/RecomputeAllElo";
import { PlayerEloRecomputeService } from "./player-elo-recompute.service";

const METADATA = join(__dirname, "../../hasura/metadata");

type Permission = { role: string; permission: { columns?: Array<string> } };

describe("voidMatchElo metadata", () => {
  it("is an administrator-only action", () => {
    const { actions } = yaml.load(
      readFileSync(join(METADATA, "actions.yaml"), "utf8"),
    ) as {
      actions: Array<{
        name: string;
        definition: { kind: string };
        permissions?: Array<{ role: string }>;
      }>;
    };

    const action = actions.find(({ name }) => name === "voidMatchElo");

    expect(action?.definition.kind).toBe("synchronous");
    expect(action?.permissions).toEqual([{ role: "administrator" }]);
  });

  it("takes the match and answers with success", () => {
    expect(readFileSync(join(METADATA, "actions.graphql"), "utf8")).toMatch(
      /voidMatchElo\(\s*match_id: uuid!\s*\): SuccessOutput\n/,
    );
  });

  it("leaves no role able to write the void columns directly", () => {
    const matches = yaml.load(
      readFileSync(
        join(METADATA, "databases/default/tables/public_matches.yaml"),
        "utf8",
      ),
    ) as {
      insert_permissions: Array<Permission>;
      update_permissions: Array<Permission>;
    };

    for (const { permission } of [
      ...matches.insert_permissions,
      ...matches.update_permissions,
    ]) {
      expect(
        (permission.columns ?? []).filter((column) =>
          column.startsWith("elo_voided"),
        ),
      ).toEqual([]);
    }
  });
});

describe("RecomputeAllElo", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("hands the job's request to the recompute", async () => {
    const recompute = { runRecomputeAll: jest.fn().mockResolvedValue(true) };
    const job = { data: { request: 7 }, moveToDelayed: jest.fn() };

    await expect(
      new RecomputeAllElo(recompute as any).process(job as any),
    ).resolves.toBeUndefined();

    expect(recompute.runRecomputeAll).toHaveBeenCalledWith(7);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("re-delays the job while another run holds the lock", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    const recompute = { runRecomputeAll: jest.fn().mockResolvedValue(false) };
    const job = {
      data: { request: 7 },
      token: "token-1",
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      new RecomputeAllElo(recompute as any).process(job as any),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      1000 + PlayerEloRecomputeService.RETRY_DELAY_MS,
      "token-1",
    );
  });

  // BullMQ refuses a custom job id holding a ":" unless it splits into exactly
  // three parts, and a mocked queue never runs that check.
  it("uses job ids BullMQ accepts", () => {
    expect(() =>
      (
        Job.prototype as unknown as {
          validateOptions(this: object, json: { data: string }): void;
        }
      ).validateOptions.call(
        {
          name: RecomputeAllElo.name,
          opts: { jobId: PlayerEloRecomputeService.jobId(12) },
        },
        { data: "{}" },
      ),
    ).not.toThrow();
  });
});
