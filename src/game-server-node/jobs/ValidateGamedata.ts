import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { NotificationsService } from "src/notifications/notifications.service";
import { DISCORD_COLORS } from "src/notifications/utilities/constants";
import { GameServerNodeService } from "../game-server-node.service";

type ValidateGamedataData = {
  gameServerNodeId: string;
  buildId: number;
  branch?: string;
};

const GAMEDATA_ROUTING = {
  webhook: "discord_gamedata_notifications_webhook",
  role: "discord_gamedata_notifications_role_id",
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

    if (result.status === "fail") {
      const items = result.broken
        .map((entry) => {
          const name =
            entry.kind === "vtable"
              ? `${entry.signature} (vtable)`
              : entry.signature;
          return `<li><code>${name}</code> — ${entry.set}</li>`;
        })
        .join("");

      this.notify(
        "Gamedata Validation Failed",
        `CS2 build <b>${buildId}</b> broke <b>${result.broken.length}</b> signature(s):<ul>${items}</ul>`,
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
        `CS2 build <b>${buildId}</b> — <b>${result.warnings.length}</b> signature(s) are no longer unique (still resolve, but matched more than once):<ul>${items}</ul>`,
        DISCORD_COLORS.ORANGE,
      );
      return;
    }

    this.notify(
      "Gamedata Validation Passed",
      `CS2 build <b>${buildId}</b> — all gamedata signatures verified.`,
      DISCORD_COLORS.GREEN,
    );
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
