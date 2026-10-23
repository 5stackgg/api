import { Job, JobSchedulerTemplateOptions, Queue, RepeatOptions } from "bullmq";
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
  | "Clips"
  | "Hasura"
  | "GameServerNode"
  | "GamePlugins"
  | "DiscordBot"
  | "Postgres"
  | "System"
  | "Notifications"
  | "TypeSense"
  | "Matchmaking"
  | "DraftGames"
  | "Telemetry"
  | "DedicatedServers"
  | "SteamMatchHistory"
  | "Faceit"
  | "Extension"
  | "S3Scan"
  | "Scrims"
  | "Chat"
  | "Utility"
  | "Voice"
  | "Sockets"
  | "MapAssets"
  | "ServerRoster"
  | "Twitch";

export type UseQueueOptions = {
  concurrency?: number;
  limiter?: { max: number; duration: number };
  maxStalledCount?: number;
};

// Every api restart mid-job is a stall, and BullMQ fails a job on its second
// one by default. A job that picks up where it left off can ride out many.
export const RESUMABLE_JOB_MAX_STALLS = 20;

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
      const processorOptions: UseQueueOptions = {};
      if (typeof options.concurrency === "number") {
        processorOptions.concurrency = options.concurrency;
      }
      if (options.limiter) {
        processorOptions.limiter = options.limiter;
      }
      if (typeof options.maxStalledCount === "number") {
        processorOptions.maxStalledCount = options.maxStalledCount;
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

// Every schedule a queue has, keyed by job name, so a changed cadence replaces
// the old one rather than running beside it. Anything not listed is removed,
// which includes schedules left by the old `repeat` option: BullMQ keys those
// by a hash of the pattern, so they never match a name.
export async function scheduleJobs(
  queue: Queue,
  schedules: Record<string, Omit<RepeatOptions, "key">>,
  opts?: JobSchedulerTemplateOptions,
): Promise<void> {
  const names = new Set(Object.keys(schedules));

  for (const [name, repeat] of Object.entries(schedules)) {
    await queue.upsertJobScheduler(name, repeat, { name, opts });
  }

  for (const scheduler of await queue.getJobSchedulers()) {
    if (scheduler && !names.has(scheduler.key)) {
      await queue.removeJobScheduler(scheduler.key);
    }
  }
}

// Runs a job at a deadline instead of on its queue's next schedule. Everything
// due in the same second shares one run, at the start of the second after next.
// That is at least a second past every deadline in it, for a job that reads the
// clock itself, and always after a run of the job already under way, which a
// wake-up with the same id would otherwise be dropped as a duplicate of. A job
// run per entity passes its id as `key`, so each entity gets its own run.
export async function wakeJobAt(
  queue: Queue,
  name: string,
  at: Date | string | number,
  scope: { key?: string; data?: Record<string, unknown> } = {},
): Promise<void> {
  const now = Date.now();
  const second = Math.floor(Math.max(now, new Date(at).getTime()) / 1000) + 2;

  if (Number.isNaN(second)) {
    return;
  }

  await queue.add(name, scope.data ?? {}, {
    jobId: [name, scope.key, "at", second].filter(Boolean).join("."),
    delay: second * 1000 - now,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}
