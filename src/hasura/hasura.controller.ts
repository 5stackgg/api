import {
  ConflictException,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Request, Response } from "express";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { ApiKeyGuard } from "../auth/strategies/ApiKeyGuard";
import { HasuraService } from "./hasura.service";
import { CacheService } from "../cache/cache.service";

type Handler = {
  target: unknown;
  retry?: boolean;
  resolved?: HandleResolver;
};

interface HandleResolver {
  [key: string]: (data: Record<string, unknown>) => Promise<void>;
}

const _events: Record<string, Handler> = {};
const _actions: Record<string, Handler> = {};

// Hasura only re-sends an event it got a non-2xx answer for, so a handler that
// throws is otherwise never retried. `retry` answers 500 instead: only for
// handlers that are safe to run twice, and minutes late.
export const HasuraEvent = (
  options: { retry?: boolean } = {},
): MethodDecorator => {
  return (target, propertyKey: string): void => {
    _events[propertyKey] = {
      target,
      retry: options.retry,
    };
  };
};

export const HasuraAction = (): MethodDecorator => {
  return (target, propertyKey: string): void => {
    _actions[propertyKey] = {
      target,
    };
  };
};

@Controller("hasura")
export class HasuraController {
  // The web's public socket sends this so its subscriptions run as a guest:
  // Hasura then polls one row for everyone watching instead of one per
  // signed-in viewer. It can only ever lower a session to a guest's.
  public static readonly ANONYMOUS_HEADER = "x-5stack-anonymous";

  // Hasura asks this hook once per socket and keeps that role until the
  // max-age in the JSON body (it ignores a Cache-Control header), then drops
  // the socket so it reconnects through here. Community Edition asks again for
  // every HTTP request; Cloud and Enterprise would cache those for the max-age.
  private static readonly ELEVATED_SESSION_MAX_AGE_SECONDS = 5 * 60;

  // Longer than any one attempt should take, so a crashed attempt's claim
  // does not hold the event back for long.
  private static readonly EVENT_RUNNING_TTL_SECONDS = 5 * 60;

  // Longer than Hasura can keep re-sending one event: 60 retries, each up to
  // its 60s timeout plus the 10s interval.
  private static readonly EVENT_DONE_TTL_SECONDS = 2 * 60 * 60;

  constructor(
    private readonly logger: Logger,
    private readonly hasuraService: HasuraService,
    private readonly modulesContainer: ModulesContainer,
    private readonly cache: CacheService,
  ) {}

  @Get()
  public async hasura(@Req() request: Request) {
    const user = request.user;

    if (!user || request.headers[HasuraController.ANONYMOUS_HEADER]) {
      return {
        "x-hasura-user-id": "0",
        "x-hasura-role": "guest",
      };
    }

    const session = await this.hasuraService.getHasuraHeaders(user.steam_id);

    if (session["x-hasura-role"] === "user") {
      return session;
    }

    return {
      ...session,
      "Cache-Control": `max-age=${HasuraController.ELEVATED_SESSION_MAX_AGE_SECONDS}`,
    };
  }

  @Post("actions")
  public async actions(@Req() request: Request, @Res() response: Response) {
    this.hasuraService.requireJsonHook(request);

    const { input, action } = request.body;

    request.body = input;

    const resolver = this.getResolver(_actions[action.name]);

    input.user = request.user;

    if (!request.user && action.name === "me") {
      return response.status(401).json({
        message: "Unauthorized",
      });
    }

    input.session = request.session;

    try {
      return response.json(await resolver[action.name].bind(resolver, input)());
    } catch (error) {
      this.logger.error(`unable to complete action ${action.name}`, error);
      return response.status(400).json({
        message: error?.message ?? error,
      });
    }
  }

  @Post("events")
  public async events(@Req() request: Request) {
    this.hasuraService.requireJsonHook(request);

    const { id, event, trigger } = request.body;

    const handler = _events[trigger.name];
    const resolver = this.getResolver(handler);

    const run = async () => {
      try {
        await resolver[trigger.name].bind(resolver, {
          op: event.op,
          old: event.data.old || {},
          new: event.data.new || {},
        })();
        return true;
      } catch (error) {
        this.logger.error(`unable to complete event ${trigger.name}`, {
          error,
          event,
          trigger,
        });
        return false;
      }
    };

    if (!handler.retry) {
      await run();
      return;
    }

    // Hasura re-sends an event it has no 2xx for, and that includes an attempt
    // still running past its 60s timeout. Claiming the event by id keeps a
    // second copy from running alongside the first, and marking it done keeps
    // one that arrives after a success from running again.
    const doneKey = `hasura-event:done:${id}`;
    const runningKey = `hasura-event:running:${id}`;

    if (id && (await this.cache.has(doneKey))) {
      return;
    }

    const token = id
      ? await this.cache.acquireLock(
          runningKey,
          HasuraController.EVENT_RUNNING_TTL_SECONDS,
        )
      : undefined;
    if (id && !token) {
      throw new ConflictException(`event ${trigger.name} is still running`);
    }

    try {
      if (!(await run())) {
        throw new InternalServerErrorException(
          `unable to complete event ${trigger.name}`,
        );
      }

      if (id) {
        await this.cache.put(
          doneKey,
          true,
          HasuraController.EVENT_DONE_TTL_SECONDS,
        );
      }
    } finally {
      if (token) {
        await this.cache.releaseLock(runningKey, token);
      }
    }
  }

  private getResolver(handler: Handler): HandleResolver {
    if (handler.resolved) {
      return handler.resolved;
    }

    /**
     * im sure this is a terrible idea
     */
    let resolved;
    const modules = [...this.modulesContainer.values()];
    for (const module of modules) {
      if (module.name === "InternalCoreModule") {
        continue;
      }
      for (const [, controller] of module.controllers) {
        if (controller.name === handler.target.constructor.name) {
          resolved = controller.instance;
          break;
        }
      }

      if (resolved) {
        break;
      }
    }

    if (!resolved) {
      throw Error("unable to find resolver");
    }
    return (handler.resolved = resolved as HandleResolver);
  }
}
