import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { NotificationsService } from "src/notifications/notifications.service";
import { DISCORD_COLORS } from "src/notifications/utilities/constants";
import {
  GameServerNodeService,
  GamedataValidationEntry,
} from "../game-server-node.service";

type ValidateGamedataData = {
  gameServerNodeId: string;
  buildId: number;
  branch?: string;
};

const GAMEDATA_ROUTING = {
  webhook: "discord_gamedata_notifications_webhook",
  role: "discord_gamedata_notifications_role_id",
};

const UNKNOWN_RUNTIME = "unknown";

// Swiftly first: it is the default game server runtime.
const RUNTIME_LABELS: Record<string, string> = {
  swiftlys2: "Swiftly",
  counterstrikesharp: "CounterStrikeSharp",
  [UNKNOWN_RUNTIME]: "Unknown Runtime",
};

@UseQueue("GameServerNode", GameServerQueues.ValidateGamedata)
export class ValidateGamedata extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly notifications: NotificationsService,
    protected readonly gameServerNodeService: GameServerNodeService,
  ) {
    super();
  }

  async process(job: Job<ValidateGamedataData>): Promise<void> {
    const { gameServerNodeId, buildId } = job.data;
    const branch = job.data.branch ?? "public";

    const result = await this.gameServerNodeService.validateGamedata(
      gameServerNodeId,
      buildId,
      branch,
    );

    if (!result) {
      this.logger.error(
        `[validate-gamedata] no result produced for build ${buildId} (${branch})`,
      );
      return;
    }

    if (result.status === "error") {
      this.notify(
        "Gamedata Validation Error",
        `Couldn't validate gamedata for CS2 build <b>${buildId}</b>.<br><code>${result.error ?? "unknown error"}</code>`,
        DISCORD_COLORS.ORANGE,
      );
      return;
    }

    const skipped = ValidateGamedata.skippedNote(result.skipped);

    if (result.status === "fail") {
      const sections = ValidateGamedata.groupByRuntime(result.broken)
        .map(([runtime, entries]) => {
          const items = entries
            .map(
              (entry) =>
                `<li><code>${ValidateGamedata.entryLabel(entry)}</code> — ${entry.set}</li>`,
            )
            .join("");
          return `<b>${RUNTIME_LABELS[runtime]}</b><ul>${items}</ul>`;
        })
        .join("");

      this.notify(
        "Gamedata Validation Failed",
        `CS2 build <b>${buildId}</b> broke <b>${result.broken.length}</b> gamedata entr${result.broken.length === 1 ? "y" : "ies"}:${sections}${skipped}`,
        DISCORD_COLORS.RED,
      );
      return;
    }

    if (result.warnings?.length) {
      const items = result.warnings
        .map(
          (entry) =>
            `<li><code>${entry.signature}</code> — ${entry.set} (${entry.count} matches)</li>`,
        )
        .join("");

      this.notify(
        "Gamedata Validation Warning",
        `CS2 build <b>${buildId}</b> — <b>${result.warnings.length}</b> signature(s) are no longer unique (still resolve, but matched more than once):<ul>${items}</ul>${skipped}`,
        DISCORD_COLORS.ORANGE,
      );
      return;
    }

    this.notify(
      "Gamedata Validation Passed",
      `CS2 build <b>${buildId}</b> — all Swiftly and CounterStrikeSharp gamedata verified.${skipped}`,
      DISCORD_COLORS.GREEN,
    );
  }

  private static entryLabel(entry: GamedataValidationEntry): string {
    if (entry.kind === "vtable" || entry.kind === "patch") {
      return `${entry.signature} (${entry.kind})`;
    }
    return entry.signature;
  }

  private static skippedNote(skipped?: Array<GamedataValidationEntry>): string {
    if (!skipped?.length) {
      return "";
    }
    return `<br><i>${skipped.length} entr${skipped.length === 1 ? "y" : "ies"} could not be checked.</i>`;
  }

  private static groupByRuntime(
    entries: Array<GamedataValidationEntry>,
  ): Array<[string, Array<GamedataValidationEntry>]> {
    const groups = new Map<string, Array<GamedataValidationEntry>>(
      Object.keys(RUNTIME_LABELS).map(
        (runtime): [string, Array<GamedataValidationEntry>] => [runtime, []],
      ),
    );

    for (const entry of entries) {
      const runtimes = entry.runtimes?.length
        ? entry.runtimes
        : [UNKNOWN_RUNTIME];

      for (const runtime of runtimes) {
        if (!groups.has(runtime)) {
          groups.set(runtime, []);
        }
        groups.get(runtime).push(entry);
      }
    }

    return [...groups].filter(([, grouped]) => grouped.length > 0);
  }

  private notify(title: string, message: string, color: number): void {
    void this.notifications.send(
      "GameUpdate",
      {
        message,
        title,
        role: "administrator",
      },
      undefined,
      color,
      undefined,
      GAMEDATA_ROUTING,
    );
  }
}
