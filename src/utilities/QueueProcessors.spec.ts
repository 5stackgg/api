import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from "@nestjs/bullmq/dist/bull.constants";
import "../map-assets/jobs/BuildMapAssets";
import "../game-server-node/jobs/ValidateGamedata";
import {
  getQueuesProcessors,
  RESUMABLE_JOB_MAX_STALLS,
} from "./QueueProcessors";

describe("UseQueue", () => {
  const workerOptions = (
    module: Parameters<typeof getQueuesProcessors>[0],
    queue: string,
  ) => {
    const processor = getQueuesProcessors(module).find(
      (candidate) =>
        Reflect.getMetadata(PROCESSOR_METADATA, candidate)?.name === queue,
    );
    return Reflect.getMetadata(WORKER_METADATA, processor);
  };

  it.each([
    ["MapAssets", "build-map-assets"],
    ["GameServerNode", "validate-gamedata"],
  ] as const)("lets the %s %s job ride out api restarts", (module, queue) => {
    expect(workerOptions(module, queue)).toMatchObject({
      maxStalledCount: RESUMABLE_JOB_MAX_STALLS,
    });
  });
});
