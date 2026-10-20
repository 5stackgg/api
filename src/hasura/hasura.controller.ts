import {
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
  constructor(
    private readonly logger: Logger,
    private readonly hasuraService: HasuraService,
    private readonly modulesContainer: ModulesContainer,
  ) {}

  @Get()
  public async hasura(@Req() request: Request) {
    const user = request.user;

    if (!user) {
      return {
        "x-hasura-user-id": "0",
        "x-hasura-role": "guest",
      };
    }

    return this.hasuraService.getHasuraHeaders(user.steam_id);
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

    const { event, trigger } = request.body;

    const handler = _events[trigger.name];
    const resolver = this.getResolver(handler);

    try {
      return await resolver[trigger.name].bind(resolver, {
        op: event.op,
        old: event.data.old || {},
        new: event.data.new || {},
      })();
    } catch (error) {
      this.logger.error(`unable to complete event ${trigger.name}`, {
        error,
        event,
        trigger,
      });

      if (handler.retry) {
        throw new InternalServerErrorException(
          `unable to complete event ${trigger.name}`,
        );
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
