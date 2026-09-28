import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import WebSocket from "ws";
import { validate } from "uuid";
import { Request } from "express";
import { ModuleRef } from "@nestjs/core";
import { MatchEvents } from "./events";
import MatchEventProcessor from "./events/abstracts/MatchEventProcessor";
import { Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";
import { timingSafeStringEqual } from "src/utilities/timingSafeStringEqual";
import type { e_match_status_enum } from "../../generated";

type MatchBinding = {
  expiresAt: number;
  mapIds: Set<string>;
};

export type FiveStackGameServerWebSocketClient = WebSocket.WebSocket & {
  authenticated?: boolean;
  serverId?: string;
  matchBindings?: Map<string, MatchBinding>;
};

@WebSocketGateway({
  path: "/ws/matches",
})
export class MatchEventsGateway {
  // A server moved off a match is still accepted for it until this runs out.
  // Checking every event instead would add a Hasura round trip to each damage
  // and kill, which arrive many times a second during a round.
  private static readonly BINDING_TTL_MS = 5 * 1000;

  private static readonly LAST_HOST_TTL_SECONDS = 60 * 60;

  private static readonly TERMINAL_STATUSES: readonly e_match_status_enum[] = [
    "Finished",
    "Canceled",
    "Forfeit",
    "Tie",
    "Surrendered",
  ];

  constructor(
    private readonly logger: Logger,
    private readonly moduleRef: ModuleRef,
    private readonly hasura: HasuraService,
    private readonly cache: CacheService,
  ) {}

  async handleConnection(
    @ConnectedSocket() client: FiveStackGameServerWebSocketClient,
    request: Request,
  ) {
    try {
      const authHeader = request.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Basic ")) {
        this.logger.warn("game server connection rejected: missing auth", {
          ip: request.headers["cf-connecting-ip"],
        });
        client.terminate();
        return;
      }

      const base64Credentials = authHeader.split(" ").at(1);
      if (!base64Credentials) {
        this.logger.warn("game server connection rejected: malformed auth", {
          ip: request.headers["cf-connecting-ip"],
        });
        client.terminate();
        return;
      }

      const decoded = Buffer.from(base64Credentials, "base64").toString();
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) {
        this.logger.warn(
          "game server connection rejected: invalid credentials format",
          {
            ip: request.headers["cf-connecting-ip"],
          },
        );
        client.terminate();
        return;
      }

      const serverId = decoded.substring(0, colonIndex);
      const apiPassword = decoded.substring(colonIndex + 1);

      const { servers_by_pk } = await this.hasura.query({
        servers_by_pk: {
          __args: {
            id: serverId,
          },
          id: true,
          api_password: true,
        },
      });

      if (
        !servers_by_pk?.id ||
        !timingSafeStringEqual(servers_by_pk.api_password, apiPassword)
      ) {
        client.terminate();
        this.logger.warn("game server auth failure", {
          serverId,
          ip: request.headers["cf-connecting-ip"],
        });
        return;
      }

      client.serverId = servers_by_pk.id;
      client.authenticated = true;
    } catch {
      client.terminate();
    }
  }

  @SubscribeMessage("events")
  async handleMatchEvent(
    @ConnectedSocket() client: FiveStackGameServerWebSocketClient,
    @MessageBody()
    message: {
      mapId?: string;
      matchId: string;
      messageId: string;
      data: {
        event: string;
        data: Record<string, unknown>;
      };
    },
  ) {
    if (!client.authenticated || !client.serverId) {
      return;
    }

    const { matchId, mapId, messageId } = message;
    const { data, event } = message.data;

    if (!(await this.isHostedBy(client, matchId, data?.match_map_id))) {
      this.logger.warn(
        "game server event refused: match is not hosted by this server",
        {
          serverId: client.serverId,
          matchId,
          event,
        },
      );
      // The plugin resends an unacknowledged message every few seconds for as
      // long as it runs, so a refusal is acknowledged to make it drop it.
      return messageId;
    }

    const cacheKey = mapId
      ? `match-events:${matchId}:${mapId}:${messageId}`
      : `match-events:${matchId}:${messageId}`;

    if (await this.cache.has(cacheKey)) {
      return messageId;
    }

    const Processor = MatchEvents[event as keyof typeof MatchEvents];

    if (!Processor) {
      this.logger.warn("unable to find event handler", event);
      return messageId;
    }

    const processor =
      await this.moduleRef.resolve<MatchEventProcessor<unknown>>(Processor);

    processor.setData(matchId, data);

    try {
      await processor.process();
    } catch (error) {
      // Do NOT write the dedup entry on failure: leave the key absent so the
      // game server's redelivery of this messageId is reprocessed instead of
      // being silently swallowed by the dedup short-circuit for its TTL.
      this.logger.error(
        `[${matchId}] error processing game event ${event} (messageId=${messageId}): ${
          (error as Error)?.message
        }`,
        (error as Error)?.stack,
      );
      throw error;
    }

    // Mark processed only after success.
    await this.cache.put(cacheKey, true, 10);

    return messageId;
  }

  // Stats and round events name their match map in the payload, so the map has
  // to belong to the match too or a server could write into another match
  // through its own.
  private async isHostedBy(
    client: FiveStackGameServerWebSocketClient,
    matchId: unknown,
    matchMapId: unknown,
  ): Promise<boolean> {
    if (typeof matchId !== "string" || !validate(matchId)) {
      return false;
    }

    if (
      matchMapId !== undefined &&
      matchMapId !== null &&
      typeof matchMapId !== "string"
    ) {
      return false;
    }

    const bindingKey = matchId.toLowerCase();
    const mapId =
      typeof matchMapId === "string" ? matchMapId.toLowerCase() : undefined;

    const cached = client.matchBindings?.get(bindingKey);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      (!mapId || cached.mapIds.has(mapId))
    ) {
      return true;
    }

    const mapIds = await this.hostedMatchMapIds(client.serverId, bindingKey);

    client.matchBindings ??= new Map();

    if (!mapIds) {
      client.matchBindings.delete(bindingKey);
      return false;
    }

    client.matchBindings.set(bindingKey, {
      expiresAt: Date.now() + MatchEventsGateway.BINDING_TTL_MS,
      mapIds,
    });

    return !mapId || mapIds.has(mapId);
  }

  // Ending a match clears its server_id while the server is still flushing
  // late events (the map Finished that follows a surrender, chat, disconnects,
  // retries), so an ended match stays open to the last server seen hosting it.
  private async hostedMatchMapIds(
    serverId: string,
    matchId: string,
  ): Promise<Set<string> | null> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        server_id: true,
        status: true,
        match_maps: {
          id: true,
        },
      },
    });

    if (!match) {
      return null;
    }

    const lastHostKey = MatchEventsGateway.lastHostKey(matchId);

    let hosted: boolean;
    if (match.server_id) {
      await this.cache.put(
        lastHostKey,
        match.server_id,
        MatchEventsGateway.LAST_HOST_TTL_SECONDS,
      );
      hosted = match.server_id === serverId;
    } else {
      hosted =
        MatchEventsGateway.TERMINAL_STATUSES.includes(match.status) &&
        (await this.cache.get(lastHostKey)) === serverId;
    }

    if (!hosted) {
      return null;
    }

    return new Set(match.match_maps.map(({ id }) => id));
  }

  private static lastHostKey(matchId: string) {
    return `match-events:last-host:${matchId}`;
  }
}
