import path from "path";
import { readFile } from "fs/promises";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../../hasura/hasura.service";
import { AppConfig } from "../../configs/types/AppConfig";

// The optional Cloudflare worker that caches the relay at the edge (see
// cloudflare-workers/playcast-relay). Game servers keep posting to the panel;
// only viewers are pointed at the worker. It has to run on a custom domain:
// Cloudflare's Cache API does nothing for workers on workers.dev.
@Injectable()
export class PlaycastRelayService {
  public static readonly SETTING = "playcast_relay_url";

  private static readonly SCRIPT_NAME = "5stack-playcast-relay";

  private static readonly COMPATIBILITY_DATE = "2025-04-29";

  private static readonly CLOUDFLARE_API =
    "https://api.cloudflare.com/client/v4";

  // A new custom domain answers once Cloudflare has issued its certificate,
  // which can take minutes. The wait stays well inside the 60s the ingress
  // gives a request: past that the browser sees a network error and retries
  // the whole deploy.
  private static readonly LIVE_TIMEOUT_MS = 20_000;

  private static readonly HOSTNAME =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    configService: ConfigService,
  ) {
    this.appConfig = configService.get<AppConfig>("app");
  }

  // The token is only used for these calls: it can deploy code to the account,
  // so it is never written anywhere.
  public async deploy(
    accountId: string,
    apiToken: string,
    hostname: string,
  ): Promise<{ url: string; ready: boolean }> {
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
      throw new Error("That does not look like a Cloudflare account ID");
    }

    if (!apiToken) {
      throw new Error("A Cloudflare API token is required");
    }

    hostname = hostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
    if (!PlaycastRelayService.HOSTNAME.test(hostname)) {
      throw new Error("Enter a hostname such as playcast.example.com");
    }
    PlaycastRelayService.refuseWorkersDev(hostname);

    const zoneId = await this.findZone(accountId, apiToken, hostname);

    const script = await readFile(
      path.resolve("./cloudflare-workers/playcast-relay/worker.js"),
      "utf8",
    );

    const form = new FormData();
    form.append(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.js",
            compatibility_date: PlaycastRelayService.COMPATIBILITY_DATE,
            bindings: [
              {
                type: "plain_text",
                name: "ORIGIN",
                text: this.appConfig.relayDomain,
              },
            ],
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.append(
      "worker.js",
      new Blob([script], { type: "application/javascript+module" }),
      "worker.js",
    );

    await this.cloudflare(
      accountId,
      apiToken,
      "PUT",
      `/workers/scripts/${PlaycastRelayService.SCRIPT_NAME}`,
      form,
    );

    await this.cloudflare(
      accountId,
      apiToken,
      "PUT",
      "/workers/domains",
      JSON.stringify({
        hostname,
        service: PlaycastRelayService.SCRIPT_NAME,
        zone_id: zoneId,
      }),
    );

    const url = `https://${hostname}`;

    this.logger.log(`playcast relay worker deployed at ${url}`);

    if (!(await this.waitUntilLive(url))) {
      return { url, ready: false };
    }

    await this.save(url);

    return { url, ready: true };
  }

  public async use(url: string | null): Promise<string | null> {
    if (!url?.trim()) {
      await this.hasura.mutation({
        delete_settings_by_pk: {
          __args: { name: PlaycastRelayService.SETTING },
          __typename: true,
        },
      });
      return null;
    }

    const normalized = PlaycastRelayService.originOf(url);

    PlaycastRelayService.refuseWorkersDev(new URL(normalized).hostname);

    await this.verify(normalized);
    await this.save(normalized);

    return normalized;
  }

  // Refuses a worker that fronts some other relay: pointing viewers at it would
  // show them another panel's broadcasts, or nothing.
  private async verify(url: string) {
    let health: { ok?: unknown; origin?: unknown } | null = null;

    try {
      const response = await fetch(`${url}/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        health = await response.json();
      }
    } catch {
      health = null;
    }

    if (health?.ok !== true) {
      throw new Error(`No 5stack playcast relay worker is answering at ${url}`);
    }

    const origin =
      typeof health.origin === "string"
        ? PlaycastRelayService.normalize(health.origin).slice(0, 200)
        : "";
    const expected = PlaycastRelayService.normalize(this.appConfig.relayDomain);

    if (origin !== expected) {
      throw new Error(
        `That worker relays ${origin || "nothing"}, not this panel's relay (${expected}). Set its ORIGIN to ${expected}.`,
      );
    }
  }

  private async waitUntilLive(url: string): Promise<boolean> {
    const deadline = Date.now() + PlaycastRelayService.LIVE_TIMEOUT_MS;

    for (;;) {
      try {
        await this.verify(url);
        return true;
      } catch {
        if (Date.now() >= deadline) {
          return false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // The zone in this account the hostname belongs to: its longest suffix that
  // is a zone.
  private async findZone(
    accountId: string,
    apiToken: string,
    hostname: string,
  ): Promise<string> {
    const labels = hostname.split(".");
    for (let start = 0; start < labels.length - 1; start++) {
      const zones = await this.cloudflare<Array<{ id: string }>>(
        accountId,
        apiToken,
        "GET",
        `/zones?name=${encodeURIComponent(labels.slice(start).join("."))}&account.id=${accountId}`,
        undefined,
        false,
      );
      if (zones?.[0]?.id) {
        return zones[0].id;
      }
    }

    throw new Error(
      `${hostname} is not on a domain in this Cloudflare account. Add the domain to Cloudflare first, or use a hostname on one that is.`,
    );
  }

  private static refuseWorkersDev(hostname: string) {
    if (/(^|\.)workers\.dev$/i.test(hostname)) {
      throw new Error(
        "Cloudflare does not cache for workers on workers.dev, so viewers would gain nothing. Give the worker a hostname on one of your own domains.",
      );
    }
  }

  private async save(url: string) {
    await this.hasura.mutation({
      insert_settings_one: {
        __args: {
          object: { name: PlaycastRelayService.SETTING, value: url },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });
  }

  private async cloudflare<T = unknown>(
    accountId: string,
    apiToken: string,
    method: string,
    route: string,
    body?: FormData | string,
    accountScoped = true,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiToken}`,
    };
    if (typeof body === "string") {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(
      `${PlaycastRelayService.CLOUDFLARE_API}${accountScoped ? `/accounts/${accountId}` : ""}${route}`,
      { method, headers, body },
    );

    const payload: {
      success?: boolean;
      result?: T;
      errors?: Array<{ message?: string }>;
    } | null = await response.json().catch((): null => null);

    if (!response.ok || payload?.success === false) {
      const reason =
        payload?.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `HTTP ${response.status}`;
      throw new Error(`Cloudflare refused ${method} ${route}: ${reason}`);
    }

    return payload?.result as T;
  }

  private static normalize(url: string) {
    return url.trim().replace(/\/+$/, "");
  }

  // Only a bare https origin: the url ends up inside the playcast "<url>/<id>"
  // command viewers paste into their console, so nothing else is let through.
  private static originOf(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new Error(
        "Enter the worker's address, such as https://playcast.example.com",
      );
    }

    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !["", "/"].includes(parsed.pathname)
    ) {
      throw new Error(
        "The worker address must be just https:// and a hostname, such as https://playcast.example.com",
      );
    }

    return `https://${parsed.host}`;
  }
}
