import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MapAssetsQueues } from "../enums/MapAssetsQueues";
import {
  MapAssetBuildOutcome,
  MapAssetBuildRun,
  MapAssetsService,
} from "../map-assets.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

type BuildMapAssetsData = Partial<MapAssetBuildRun> & {
  gameServerNodeId: string;
  buildId: string;
};

@UseQueue("MapAssets", MapAssetsQueues.BuildMapAssets)
export class BuildMapAssets extends WorkerHost {
  private static readonly LIST_LIMIT = 10;

  private static readonly ERROR_CHARS = 300;

  constructor(
    protected readonly logger: Logger,
    protected readonly mapAssets: MapAssetsService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<BuildMapAssetsData>): Promise<void> {
    const { gameServerNodeId } = job.data;
    const buildId = String(job.data.buildId);

    const outcome = await this.mapAssets.build(
      gameServerNodeId,
      buildId,
      job.data.force === true,
    );

    if (outcome.status === "Failed") {
      this.logger.error(
        `[map-assets] build ${buildId} failed on ${gameServerNodeId}: ${outcome.error}`,
      );
    } else {
      this.logger.log(
        `[map-assets] published build ${buildId} (${Object.keys(outcome.maps ?? {}).length} maps)`,
      );
    }

    await this.notifications.sendCs2Build(
      buildId,
      BuildMapAssets.notice(buildId, outcome, job.data),
    );
  }

  public static notice(
    buildId: string,
    outcome: MapAssetBuildOutcome,
    run: Pick<
      BuildMapAssetsData,
      "gameServerNodeId" | "trigger" | "requestedByName" | "force"
    >,
  ): { title: string; message: string; color: number } {
    const esc = NotificationsService.escapeHtml;
    const build = `<b>${esc(buildId)}</b>`;
    const runNote = BuildMapAssets.runNote(run);

    if (outcome.status === "Failed") {
      const error = (outcome.error ?? "unknown error").slice(
        0,
        BuildMapAssets.ERROR_CHARS,
      );
      return {
        title: "Map Assets Build Failed",
        message: `Map assets for CS2 build ${build} failed.${outcome.kept_published ? " The published assets are unchanged." : ""}<br><code>${esc(error)}</code>${runNote}`,
        color: DISCORD_COLORS.RED,
      };
    }

    const total = Object.keys(outcome.maps ?? {}).length;
    const took = BuildMapAssets.duration(
      outcome.started_at,
      outcome.finished_at,
    );
    const summary = `CS2 build ${build}: <b>${total}</b> ${total === 1 ? "map" : "maps"} published${took ? ` in ${took}` : ""}.${BuildMapAssets.changesNote(outcome)}`;

    if (outcome.status === "Partial") {
      const failures = [
        ...(outcome.failed ?? []).map(
          (map) => `<code>${esc(map)}</code> — collision or callouts`,
        ),
        ...(outcome.failed_view ?? []).map(
          (map) => `<code>${esc(map)}</code> — view mesh`,
        ),
      ];
      return {
        title: "Map Assets Published With Failures",
        message: `${summary}<br><b>${failures.length}</b> did not fully build:${BuildMapAssets.capList(failures)}${runNote}`,
        color: DISCORD_COLORS.ORANGE,
      };
    }

    return {
      title: "Map Assets Published",
      message: `${summary}${runNote}`,
      color: DISCORD_COLORS.GREEN,
    };
  }

  private static changesNote(outcome: MapAssetBuildOutcome): string {
    const changes = outcome.changes;
    if (!changes?.comparable || !outcome.previous_build_id) {
      return "";
    }

    const esc = NotificationsService.escapeHtml;
    const names = (maps: Array<string>) => {
      const shown = maps
        .slice(0, BuildMapAssets.LIST_LIMIT)
        .map((map) => `<code>${esc(map)}</code>`)
        .join(", ");
      const more =
        maps.length > BuildMapAssets.LIST_LIMIT
          ? ` and ${maps.length - BuildMapAssets.LIST_LIMIT} more`
          : "";
      return ` (${shown}${more})`;
    };

    const parts = [
      `<b>${changes.rebuilt.length}</b> rebuilt${changes.rebuilt.length ? names(changes.rebuilt.map(({ map }) => map)) : ""}`,
      ...(changes.added.length
        ? [`<b>${changes.added.length}</b> added${names(changes.added)}`]
        : []),
      ...(changes.removed.length
        ? [`<b>${changes.removed.length}</b> removed${names(changes.removed)}`]
        : []),
      `<b>${changes.unchanged}</b> unchanged`,
    ];

    return `<br>Since build <b>${esc(outcome.previous_build_id)}</b>: ${parts.join(", ")}.`;
  }

  private static runNote(
    run: Pick<
      BuildMapAssetsData,
      "gameServerNodeId" | "trigger" | "requestedByName" | "force"
    >,
  ): string {
    const esc = NotificationsService.escapeHtml;
    const node = esc(run.gameServerNodeId);
    if (run.trigger === "auto") {
      return `<br><i>Automatic run on ${node}.</i>`;
    }
    const kind = run.force ? "Forced rebuild" : "Manual run";
    const by = run.requestedByName ? ` by ${esc(run.requestedByName)}` : "";
    return `<br><i>${kind}${by} on ${node}.</i>`;
  }

  private static capList(items: Array<string>): string {
    const shown = items
      .slice(0, BuildMapAssets.LIST_LIMIT)
      .map((item) => `<li>${item}</li>`);
    if (items.length > BuildMapAssets.LIST_LIMIT) {
      shown.push(
        `<li>…and ${items.length - BuildMapAssets.LIST_LIMIT} more</li>`,
      );
    }
    return `<ul>${shown.join("")}</ul>`;
  }

  public static duration(
    startedAt: Date | string | null | undefined,
    finishedAt: Date | string | null | undefined,
  ): string | null {
    if (!startedAt || !finishedAt) {
      return null;
    }
    const seconds = Math.round(
      (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    );
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes) {
      return `${minutes}m ${rest}s`;
    }
    return `${rest}s`;
  }
}
