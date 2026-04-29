import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Service } from "../s3/s3.service";
import { AppConfig } from "../configs/types/AppConfig";

export type ParsedRound = {
  round: number;
  start_tick: number;
  end_tick: number;
  winner?: string;
  reason?: number;
};

export type ParsedKill = {
  tick: number;
  killer?: string;
  victim?: string;
  assist?: string;
  weapon?: string;
  headshot?: boolean;
  wallbang?: boolean;
  noscope?: boolean;
  smoke?: boolean;
};

export type ParsedBomb = {
  tick: number;
  type: "planted" | "defused" | "exploded";
  player?: string;
  site?: "A" | "B";
};

export type ParsedDemo = {
  total_ticks: number;
  tick_rate: number;
  map_name?: string;
  workshop_id?: string;
  cs2_build?: string;
  round_ticks: ParsedRound[];
  kills: ParsedKill[];
  bombs: ParsedBomb[];
};

/**
 * Demo parser client. Talks HTTP to the standalone demo-parser
 * deployment (5stack-panel/base/demo-parser/) — the parser is its
 * own image (ghcr.io/5stackgg/demo-parser) wrapping
 * markus-wa/demoinfocs-golang. The api never streams demo bytes
 * itself; the parser fetches from S3 via the presigned URL we
 * hand it.
 */
@Injectable()
export class DemoParserService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
  }

  /**
   * Mint a presigned GET, hand it to demo-parser over HTTP, return
   * the parsed result. Caller is responsible for persisting.
   *
   * @param matchMapDemoId  forwarded to the parser only for log
   *                        correlation — the parser doesn't read
   *                        or write anything by this id.
   */
  public async parseFromS3Key(
    s3Key: string,
    matchMapDemoId?: string,
  ): Promise<ParsedDemo> {
    const presignedUrl = await this.s3.getPresignedUrl(
      s3Key,
      undefined,
      // 30 minutes — generous so the parser can retry transient s3
      // hiccups without re-asking for a new URL.
      60 * 30,
      "get",
    );

    const url = `${this.appConfig.demoParserUrl}/parse`;
    this.logger.log(
      `[demo-parser] POST ${url} (s3_key=${s3Key}${matchMapDemoId ? ` id=${matchMapDemoId}` : ""})`,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_map_demo_id: matchMapDemoId ?? "",
          demo_url: presignedUrl,
        }),
        // Pro CS2 demos parse in 5-15s. Cap at 5min so a stuck
        // parser doesn't block forever; the parser pod's own
        // livenessProbe will recycle it after that.
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const cause = (error as Error)?.cause as
        | { code?: string; message?: string }
        | undefined;
      const code = cause?.code;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw new Error(
          `demo-parser DNS lookup failed (${this.appConfig.demoParserUrl}) — is the deployment installed? See 5stack-panel/base/demo-parser`,
        );
      }
      if (code === "ECONNREFUSED") {
        throw new Error(
          `demo-parser is up but rejecting connections — pod not yet ready`,
        );
      }
      throw new Error(`demo-parser unreachable: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `demo-parser ${res.status}: ${text.slice(0, 300).trim()}`,
      );
    }

    const parsed = (await res.json()) as ParsedDemo;
    this.logger.log(
      `[demo-parser] parsed: ${parsed.total_ticks} ticks @ ${parsed.tick_rate} tps, ${parsed.round_ticks?.length ?? 0} rounds, ${parsed.kills?.length ?? 0} kills, ${parsed.bombs?.length ?? 0} bombs, map=${parsed.map_name ?? "<unknown>"}${parsed.workshop_id ? ` (workshop ${parsed.workshop_id})` : ""}`,
    );
    return parsed;
  }
}
