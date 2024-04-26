import { Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Request } from "express";
import { SteamGuard } from "../auth/strategies/SteamGuard";

type Handler = {
  target: unknown;
  resolved?: HandleResolver;
};

interface HandleResolver {
  [key: string]: (data: Record<string, unknown>) => Promise<void>;
}

const _events: Record<string, Handler> = {};
const _actions: Record<string, Handler> = {};

export const HasuraEvent = (): MethodDecorator => {
  return (target, propertyKey: string): void => {
    _events[propertyKey] = {
      target,
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
  constructor(private readonly modulesContainer: ModulesContainer) {}

  @UseGuards(SteamGuard)
  @Get()
  public hasura(@Req() request: Request) {
    const user = request.user;

    if (!user) {
      return;
    }

    return {
      "x-hasura-role": "user",
      "x-hasura-user-id": user.steam_id.toString(),
    };
  }

  @Post("actions")
  public async actions(@Req() request: Request) {
    const { input, action } = request.body;

    request.body = input;

    const resolver = this.getResolver(_actions[action.name]);

    input.user = request.user;

    return resolver[action.name].bind(resolver, input)();
  }

  @HasuraAction()
  public async me(@Req() request: Request) {
    return request.user;
  }

  @Post("events")
  public async events(@Req() request: Request) {
    const { event, trigger } = request.body;

    const resolver = this.getResolver(_events[trigger.name]);

    return await resolver[event.name].bind(resolver, {
      op: event.op,
      old: event.data.old || {},
      new: event.data.new || {},
    })();
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
