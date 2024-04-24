import { Controller, Post, Request } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";

const _events: Record<
  string,
  {
    name: string;
    target: unknown;
    resolved?: boolean;
  }
> = {};

export const HasuraEvent = (): MethodDecorator => {
  return (target, propertyKey: string): void => {
    _events[propertyKey] = {
      target,
      name: propertyKey,
    };
  };
};

@Controller("hasura")
export class EventsController {
  constructor(private readonly modulesContainer: ModulesContainer) {}

  @Post("events")
  public async handler(@Request() request) {
    const { event, trigger } = request.body;

    request.data = {
      op: event.op,
      old: event.data.old || {},
      new: event.data.new || {},
    };

    const handler = _events[trigger.name];

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

    return await handler.resolved[handler.name].bind(
      handler.resolved,
      request.data
    )();
  }
}
