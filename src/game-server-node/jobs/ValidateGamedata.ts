import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import {
  RESUMABLE_JOB_MAX_STALLS,
  UseQueue,
} from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { NotificationsService } from "src/notifications/notifications.service";
import { DISCORD_COLORS } from "src/notifications/utilities/constants";
import {
  BuildRunTrigger,
  GameServerNodeService,
  GamedataChangeEntry,
  GamedataValidationEntry,
  GamedataValidationOutcome,
} from "../game-server-node.service";
import { MapAssetsService } from "src/map-assets/map-assets.service";

type ValidateGamedataData = {
  gameServerNodeId: string;
  buildId: number;
  branch?: string;
  buildMapAssets?: boolean;
  trigger?: BuildRunTrigger;
  requestedBy?: string | null;
  requestedByName?: string | null;
};

const UNKNOWN_RUNTIME = "unknown";

// Swiftly first: it is the default game server runtime.
const RUNTIME_LABELS: Record<string, string> = {
  swiftlys2: "Swiftly",
  counterstrikesharp: "CounterStrikeSharp",
  [UNKNOWN_RUNTIME]: "Unknown Runtime",
};

@UseQueue("GameServerNode", GameServerQueues.ValidateGamedata, {
  maxStalledCount: RESUMABLE_JOB_MAX_STALLS,
})
export class ValidateGamedata extends WorkerHost {
  private static readonly LIST_LIMIT = 10;

  constructor(
    protected readonly logger: Logger,
    protected readonly notifications: NotificationsService,
    protected readonly gameServerNodeService: GameServerNodeService,
    protected readonly mapAssets: MapAssetsService,
  ) {
    super();
  }

  // The map-assets build for a new CS2 version waits for this validation,
  // pass or fail, so the two never share the node's install at once.
  async process(job: Job<ValidateGamedataData>): Promise<void> {
    try {
      await this.validate(job);
    } finally {
      if (job.data.buildMapAssets) {
        await this.mapAssets
          .queueBuild(job.data.gameServerNodeId, job.data.buildId)
          .catch((error) => {
            this.logger.warn(
              `[map-assets] unable to queue build ${job.data.buildId}`,
              error,
            );
          });
      }
    }
  }

  private async validate(job: Job<ValidateGamedataData>): Promise<void> {
    const { gameServerNodeId, buildId } = job.data;
    const branch = job.data.branch ?? "public";

    const outcome = await this.gameServerNodeService.validateGamedata(
      gameServerNodeId,
      buildId,
      branch,
      {
        trigger: job.data.trigger ?? "manual",
        requestedBy: job.data.requestedBy ?? null,
      },
      job.id,
    );

    if (!outcome) {
      this.logger.error(
        `[validate-gamedata] no result produced for build ${buildId} (${branch})`,
      );
      return;
    }

    const notice = ValidateGamedata.notice(buildId, outcome, job.data);

    void this.notifications.sendCs2Build(buildId, notice);
  }

  public static notice(
    buildId: number,
    { result, changes, previousBuildId }: GamedataValidationOutcome,
    run: Pick<
      ValidateGamedataData,
      "gameServerNodeId" | "trigger" | "requestedByName"
    >,
  ): { title: string; message: string; color: number } {
    const esc = NotificationsService.escapeHtml;
    const build = `<b>${esc(String(buildId))}</b>`;
    const runNote = ValidateGamedata.runNote(run);
    const skipped = ValidateGamedata.skippedNote(result.skipped);
    const since =
      changes?.comparable && previousBuildId
        ? ` since build <b>${esc(String(previousBuildId))}</b>`
        : "";

    if (result.status === "error") {
      return {
        title: "Gamedata Validation Error",
        message: `Couldn't validate gamedata for CS2 build ${build}.<br><code>${esc(GameServerNodeService.gamedataErrorReason(result) ?? "unknown error")}</code>${runNote}`,
        color: DISCORD_COLORS.ORANGE,
      };
    }

    const newlyBroken = new Set(
      (changes?.newly_broken ?? []).map(GameServerNodeService.gamedataEntryKey),
    );
    const fixed = changes?.fixed ?? [];

    if (result.status === "fail") {
      const sections = ValidateGamedata.groupByRuntime(result.broken)
        .map(([runtime, entries]) => {
          const items = ValidateGamedata.capList(
            entries.map((entry) => {
              const isNew = newlyBroken.has(
                GameServerNodeService.gamedataEntryKey(entry),
              );
              return `<code>${esc(ValidateGamedata.entryLabel(entry))}</code> — ${esc(entry.set)}${isNew ? " <i>new</i>" : ""}`;
            }),
          );
          return `<b>${RUNTIME_LABELS[runtime] ?? esc(runtime)}</b>${items}`;
        })
        .join("");

      const diff = since
        ? ` (<b>${newlyBroken.size}</b> new, <b>${fixed.length}</b> fixed${since})`
        : "";

      return {
        title: "Gamedata Validation Failed",
        message: `CS2 build ${build} broke <b>${result.broken.length}</b> gamedata ${ValidateGamedata.entries(result.broken.length)}${diff}:${sections}${skipped}${runNote}`,
        color: DISCORD_COLORS.RED,
      };
    }

    if (result.warnings?.length) {
      const newWarnings = new Set(
        (changes?.new_warnings ?? []).map(
          GameServerNodeService.gamedataEntryKey,
        ),
      );
      const items = ValidateGamedata.capList(
        result.warnings.map((entry) => {
          const isNew = newWarnings.has(
            GameServerNodeService.gamedataEntryKey(entry),
          );
          return `<code>${esc(entry.signature)}</code> — ${esc(entry.set)} (${entry.count} matches)${isNew ? " <i>new</i>" : ""}`;
        }),
      );

      return {
        title: "Gamedata Validation Warning",
        message: `CS2 build ${build}: <b>${result.warnings.length}</b> ${result.warnings.length === 1 ? "signature is" : "signatures are"} no longer unique (still resolve, but matched more than once):${items}${ValidateGamedata.fixedNote(fixed, since)}${skipped}${runNote}`,
        color: DISCORD_COLORS.ORANGE,
      };
    }

    return {
      title: "Gamedata Validation Passed",
      message: `CS2 build ${build}: all Swiftly and CounterStrikeSharp gamedata verified.${ValidateGamedata.fixedNote(fixed, since)}${skipped}${runNote}`,
      color: DISCORD_COLORS.GREEN,
    };
  }

  private static entries(count: number): string {
    return count === 1 ? "entry" : "entries";
  }

  private static fixedNote(
    fixed: Array<GamedataChangeEntry>,
    since: string,
  ): string {
    if (!fixed.length) {
      return "";
    }
    const names = fixed
      .slice(0, ValidateGamedata.LIST_LIMIT)
      .map(
        (entry) =>
          `<code>${NotificationsService.escapeHtml(entry.signature)}</code>`,
      )
      .join(", ");
    const more =
      fixed.length > ValidateGamedata.LIST_LIMIT
        ? ` and ${fixed.length - ValidateGamedata.LIST_LIMIT} more`
        : "";
    return `<br><b>${fixed.length}</b> fixed${since}: ${names}${more}.`;
  }

  private static runNote(
    run: Pick<
      ValidateGamedataData,
      "gameServerNodeId" | "trigger" | "requestedByName"
    >,
  ): string {
    const esc = NotificationsService.escapeHtml;
    const node = esc(run.gameServerNodeId);
    if (run.trigger === "auto") {
      return `<br><i>Automatic run on ${node}.</i>`;
    }
    const by = run.requestedByName ? ` by ${esc(run.requestedByName)}` : "";
    return `<br><i>Manual run${by} on ${node}.</i>`;
  }

  private static capList(items: Array<string>): string {
    const shown = items
      .slice(0, ValidateGamedata.LIST_LIMIT)
      .map((item) => `<li>${item}</li>`);
    if (items.length > ValidateGamedata.LIST_LIMIT) {
      shown.push(
        `<li>…and ${items.length - ValidateGamedata.LIST_LIMIT} more</li>`,
      );
    }
    return `<ul>${shown.join("")}</ul>`;
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
    return `<br><i>${skipped.length} ${ValidateGamedata.entries(skipped.length)} could not be checked.</i>`;
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
}
