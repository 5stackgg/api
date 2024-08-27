import { Job } from "bullmq";
import { Logger, Provider } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Processor } from "@nestjs/bullmq";
import { WorkerHost } from "@nestjs/bullmq/dist/hosts/worker-host.class";

class QueueProcessors {}

type Modules =
  | "Matches"
  | "Hasura"
  | "GameServerNode"
  | "DiscordBot"
  | "Postgres";

export const UseQueue = (module: Modules, queue: string): ClassDecorator => {
  return (target) => {
    if (!Reflect.hasMetadata("jobs", QueueProcessors)) {
      Reflect.defineMetadata("jobs", [], QueueProcessors);
    }

    if (!Reflect.hasMetadata("processors", QueueProcessors)) {
      Reflect.defineMetadata("processors", {}, QueueProcessors);
    }

    const jobs = Reflect.getMetadata("jobs", QueueProcessors) as Record<
      string,
      Object
    >;

    const processors = Reflect.getMetadata(
      "processors",
      QueueProcessors,
    ) as Record<string, Record<string, Function>>;

    if (!processors[module]) {
      processors[module] = {};
    }

    jobs[target.name] = target;
    Reflect.defineMetadata("jobs", jobs, QueueProcessors);

    if (!processors[module][queue]) {
      @Processor(queue)
      class QueueProcessor extends WorkerHost<any> {
        constructor(
          protected readonly logger: Logger,
          protected readonly moduleRef: ModuleRef,
        ) {
          super();
        }

        public async process(job: Job): Promise<any> {
          const _jobs = Reflect.getMetadata("jobs", QueueProcessors);

          const targetInstance = this.moduleRef.get(_jobs[job.name], {
            strict: false,
          });
          try {
            await targetInstance.process(job);
          } catch (error) {
            this.logger.error(`[${job.name}}] job failed`, error);
            throw error;
          }
        }
      }

      processors[module][queue] = QueueProcessor;

      Reflect.defineMetadata("processors", processors, QueueProcessors);
    }
  };
};

export function getQueuesProcessors(module: Modules): Provider[] {
  return Object.values(
    Reflect.getMetadata("processors", QueueProcessors)[module],
  );
}
