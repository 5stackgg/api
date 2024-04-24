import { Controller, Get, Post, Request, UseGuards } from "@nestjs/common";
import { SteamGuard } from "../../auth/strategies/SteamGuard";
import { ModulesContainer } from "@nestjs/core";

const _actions: Record<string, any> = [];
export const HasuraAction = (): MethodDecorator => {
  return (target, propertyKey: string): void => {
    _actions[propertyKey] = {
      target,
      name: propertyKey,
    };
  };
};

@Controller("hasura")
export class ActionsController {
  constructor(private readonly modulesContainer: ModulesContainer) {}

  @UseGuards(SteamGuard)
  @Get()
  public hasura(@Request() request) {
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
  public async handler(@Request() request) {
    const { input, action } = request.body;

    request.body = input;

    const handler = _actions[action.name];

    /**
     * im sure this is a terrible idea, but i guess it only happens once....
     */
    if (!handler.resolved) {
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
      handler.resolved = resolved;
    }

    input.user = request.user;

    return await handler.resolved[handler.name].bind(handler.resolved, input)();
  }

  @HasuraAction()
  public async me(@Request() request) {
    return request.user;
  }
}
