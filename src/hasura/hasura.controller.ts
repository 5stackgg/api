import { Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Request, Response } from "express";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import {CacheService} from "../cache/cache.service";
import {HasuraService} from "./hasura.service";

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
  constructor(
      private readonly cache: CacheService,
      private readonly hasuraService: HasuraService,
      private readonly modulesContainer: ModulesContainer,
  ) {}


  public static PLAYER_CACHE_KEY(steamId: bigint | string) {
    return `user:${steamId.toString()}`;
  }

  @UseGuards(SteamGuard)
  @Get()
  public async hasura(@Req() request: Request) {
    const user = request.user;

    if (!user) {
      return;
    }

    return await this.cache.remember(HasuraController.PLAYER_CACHE_KEY(user.steam_id), async () => {

      const { players_by_pk } =  await this.hasuraService.query({
        players_by_pk: {
          __args: {
            steam_id: user.steam_id
          },
          role: true,
        }
      });

      if(!players_by_pk) {
        return;
      }

      return {
        "x-hasura-role": players_by_pk.role,
        "x-hasura-user-id": user.steam_id.toString(),
      };
    }, 60 * 60 * 1000)
  }

  @Post("actions")
  public async actions(@Req() request: Request, @Res() response: Response) {
    const { input, action } = request.body;

    request.body = input;

    const resolver = this.getResolver(_actions[action.name]);

    input.user = request.user;

    try {
      response.json(await resolver[action.name].bind(resolver, input)());
    } catch (error) {
      return response.status(400).json({
        message: error?.message ?? error,
      });
    }
  }

  @HasuraAction()
  public async me(@Req() request: Request) {
    return request.user;
  }

  @Post("events")
  public async events(@Req() request: Request) {
    const { event, trigger } = request.body;

    const resolver = this.getResolver(_events[trigger.name]);

    return await resolver[trigger.name].bind(resolver, {
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
