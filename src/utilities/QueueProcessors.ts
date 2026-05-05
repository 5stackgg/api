import { Job } from "bullmq";
import { Logger, Provider } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Processor } from "@nestjs/bullmq";
import { WorkerHost } from "@nestjs/bullmq/dist/hosts/worker-host.class";

class QueueProcessors {}

const BULLMQ_CONTROL_FLOW_ERRORS = [
  "DelayedError",
  "WaitingError",
  "WaitingChildrenError",
];

type Modules =
  | "Matches"
  | "Demos"
  | "Hasura"
  | "GameServerNode"
  | "DiscordBot"
  | "Postgres"
  | "System"
  | "TypeSense"
  | "Matchmaking"
  | "Telemetry"
  | "DedicatedServers";

export type UseQueueOptions = {
  // Maximum number of jobs the worker will run in parallel. BullMQ
  // defaults to 1; pass a different number explicitly when a job is
  // safe to parallelise. Note: this is per-process; multi-replica
  // deployments multiply.
  concurrency?: number;
  // Rate limiter — caps how many jobs the worker pulls per duration.
  // Useful for renders that hit a shared resource (GPU pool, demo
  // S3 egress) and we want to throttle even if concurrency would
  // otherwise let more through.
  limiter?: { max: number; duration: number };
};

export const UseQueue = (
  module: Modules,
  queue: string,
  options: UseQueueOptions = {},
): ClassDecorator => {
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
      // @Processor's options are forwarded into the bull-mq Worker
      // constructor, so concurrency / limiter set here apply to the
      // whole worker — even though only this one job's `@UseQueue`
      // call passed them. That's fine because each (module, queue)
      // pair gets exactly one Processor; subsequent UseQueue calls
      // for the same queue (different job classes) are no-ops here.
      //
      // We OMIT undefined keys instead of passing `concurrency:
      // undefined` because BullMQ's Worker constructor explicitly
      // rejects "concurrency must be a finite number greater than 0"
      // — `undefined` doesn't take the default-1 path, it crashes
      // module init. Same defensiveness for `limiter`.
      const processorOptions: {
        concurrency?: number;
        limiter?: { max: number; duration: number };
      } = {};
      if (typeof options.concurrency === "number") {
        processorOptions.concurrency = options.concurrency;
      }
      if (options.limiter) {
        processorOptions.limiter = options.limiter;
      }
      const processorDecorator =
        Object.keys(processorOptions).length > 0
          ? Processor(queue, processorOptions)
          : Processor(queue);

      @processorDecorator
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
            const errorName = error instanceof Error ? error.name : undefined;
            if (!BULLMQ_CONTROL_FLOW_ERRORS.includes(errorName)) {
              this.logger.error(`[${job.name}] job failed`, error);
            }
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
