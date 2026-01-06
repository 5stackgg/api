import zlib from "zlib";
import archiver from "archiver";
import { Injectable, Logger } from "@nestjs/common";
import { PassThrough, Writable } from "stream";
import {
  Log,
  KubeConfig,
  CoreV1Api,
  V1Pod,
  BatchV1Api,
} from "@kubernetes/client-node";

@Injectable()
export class LoggingService {
  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;
  private namespace = "5stack";
  private kubeConfig: KubeConfig;

  constructor(protected readonly logger: Logger) {
    this.kubeConfig = new KubeConfig();

    this.kubeConfig.loadFromDefault();

    this.coreApi = this.kubeConfig.makeApiClient(CoreV1Api);
    this.batchApi = this.kubeConfig.makeApiClient(BatchV1Api);
  }

  public async getServiceLogs(
    service: string,
    stream: Writable,
    tailLines: number,
    previous = false,
    download = false,
    isJob = false,
    since?: {
      start: string;
      until: string;
    },
  ): Promise<void> {
    let archive: archiver.Archiver;

    if (download) {
      archive = archiver("zip", {
        zlib: { level: zlib.constants.Z_NO_COMPRESSION },
      });

      archive.on("error", (err) => {
        this.logger.error("Archive stream error", err);

        try {
          stream.destroy(err);
        } catch {
          stream.end();
        }
      });

      stream.on("error", (err) => {
        this.logger.error("Output stream error", err);

        try {
          archive.abort();
        } catch {
          archive.end();
        }
      });

      archive.pipe(stream);
    }

    let pods: V1Pod[] = [];
    if (isJob) {
      const pod = await this.getJobPod(service);
      if (pod) {
        pods.push(pod);
      }
    } else {
      pods = await this.getPodsFromService(service);
    }

    const podLogs: Promise<void>[] = [];

    for (const pod of pods) {
      podLogs.push(
        this.getLogsForPod(
          pod,
          stream,
          download,
          previous,
          archive,
          download ? undefined : tailLines,
          since,
        ),
      );
    }

    await Promise.all(podLogs);

    if (pods.length === 0) {
      stream.end();
    }
  }

  private async getPodsFromService(service: string) {
    let pods = await this.getPods();
    return pods.filter((item) => {
      return (
        item.metadata?.name?.startsWith(service) &&
        item.status?.phase === "Running"
      );
    });
  }

  private async getPods(namespace = this.namespace) {
    const podList = await this.coreApi.listNamespacedPod({
      namespace,
    });
    return podList.items;
  }

  private async getFirstLogTimestamp(
    logApi: Log,
    namespace: string,
    pod: V1Pod,
    containerName: string,
    previous: boolean,
  ) {
    const logStream = new PassThrough();
    await logApi.log(namespace, pod.metadata.name, containerName, logStream, {
      previous,
      timestamps: true,
      limitBytes: 8 * 1024,
    });

    return await new Promise((resolve) => {
      logStream.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n")) {
          const data = line.trim();
          if (data.length === 0) {
            return;
          }
          const log = this.parseLog(data);
          if (log.timestamp) {
            resolve(new Date(log.timestamp));
          }
        }
      });

      logStream.on("end", () => {
        resolve(null);
      });
    });
  }

  private async tryGetPodLogs(
    logApi: Log,
    namespace: string,
    pod: V1Pod,
    containerName: string,
    logStream: PassThrough,
    stream: Writable,
    previous: boolean,
    download: boolean,
    tailLines: number = 250,
    since?: string,
  ): Promise<void> {
    try {
      let podLogs: Awaited<ReturnType<typeof logApi.log>>;

      stream.on("end", () => {
        podLogs?.abort();
      });

      stream.on("close", () => {
        podLogs?.abort();
      });

      stream.on("error", () => {
        podLogs?.abort();
        stream.end();
      });

      podLogs = await logApi.log(
        namespace,
        pod.metadata.name,
        containerName,
        logStream,
        {
          previous,
          pretty: false,
          timestamps: true,
          tailLines: since || download ? undefined : tailLines || 250,
          ...(since
            ? {
                sinceTime: since,
              }
            : {
                follow: download === false,
              }),
        },
      );
    } catch (error) {
      if (!(await this.isNodeOnline(pod.spec.nodeName))) {
        this.logger.warn(
          `Skipping logs for pod ${pod.metadata.name} on offline node ${pod.spec.nodeName}`,
        );
        return;
      }

      this.logger.warn(
        `Failed to get logs for pod ${pod.metadata.name}, container ${containerName}`,
        error,
      );

      stream.end();
    }
  }

  public async getLogsForPod(
    pod: V1Pod,
    stream: Writable,
    download = false,
    previous = false,
    archive?: archiver.Archiver,
    tailLines?: number,
    since?: {
      start: string;
      until: string;
    },
  ) {
    let totalAdded = 0;
    let streamEnded = false;

    let oldestTimestamp: Date;
    const until = since ? new Date(since.until) : undefined;

    const endStream = () => {
      if (oldestTimestamp) {
        stream.emit(
          "data",
          JSON.stringify({
            oldest_timestamp: oldestTimestamp.toISOString(),
          }),
        );
      }

      if (!streamEnded) {
        streamEnded = true;
        stream.end();
      }
    };

    let totalLines = 0;
    for (const container of pod.spec.containers) {
      const logStream = new PassThrough();

      logStream.on("end", async () => {
        ++totalAdded;

        if (totalLines < tailLines) {
          this.logger.log(
            `loading more logs from service ${pod.metadata.name}...`,
          );

          const firstLogTimestamp = await this.getFirstLogTimestamp(
            logApi,
            this.namespace,
            pod,
            container.name,
            previous,
          );

          const until = new Date(oldestTimestamp.toISOString());
          oldestTimestamp.setMinutes(oldestTimestamp.getMinutes() - 60);

          if (oldestTimestamp < firstLogTimestamp) {
            endStream();
            return;
          }

          await this.getLogsForPod(
            pod,
            stream,
            download,
            previous,
            archive,
            tailLines - totalLines,
            {
              start: oldestTimestamp.toISOString(),
              until: until.toISOString(),
            },
          );
          return;
        }

        if (archive && totalAdded == pod.spec.containers.length) {
          void archive.finalize();
        }
        endStream();
      });

      logStream.on("data", (chunk: Buffer) => {
        if (archive) {
          return;
        }

        let text = chunk.toString().trim();

        if (text.length === 0) {
          return;
        }

        for (let data of text.split(/\n/)) {
          const { timestamp, log } = this.parseLog(data);

          if (new Date(timestamp)) {
            const latestTimestamp = new Date(timestamp);

            if (!oldestTimestamp || oldestTimestamp > latestTimestamp) {
              if (!oldestTimestamp) {
                stream.emit(
                  "data",
                  JSON.stringify({
                    oldest_timestamp: latestTimestamp.toISOString(),
                  }),
                );
              }
              oldestTimestamp = latestTimestamp;
            }

            if (since && latestTimestamp && latestTimestamp >= until) {
              continue;
            }
          }

          totalLines++;

          stream.write(
            JSON.stringify({
              pod: pod.metadata.name,
              node: pod.spec.nodeName,
              container: container.name,
              timestamp,
              log,
            }),
          );
        }
      });

      logStream.on("error", (error) => {
        this.logger.error("Log stream error", error);
        endStream();
      });

      logStream.on("close", () => {
        endStream();
      });

      if (archive) {
        archive.append(logStream, {
          name: `${container.name}.txt`,
        });
      }

      const logApi = new Log(this.kubeConfig);

      await this.tryGetPodLogs(
        logApi,
        this.namespace,
        pod,
        container.name,
        logStream,
        stream,
        previous,
        download,
        tailLines,
        since?.start,
      );
    }
  }

  private parseLog(log: string) {
    const timestampMatch = log.match(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/,
    );
    const timestamp = timestampMatch ? timestampMatch[0] : "";
    if (timestamp) {
      log = log.replace(timestampMatch[0], "");
    }
    return {
      log,
      timestamp,
    };
  }

  public async getJobStatus(jobName: string) {
    try {
      const job = await this.batchApi.readNamespacedJob({
        name: jobName,
        namespace: this.namespace,
      });
      return job.status;
    } catch (error) {
      if (error.code.toString() !== "404") {
        throw error;
      }
    }
  }

  public async getJobPod(jobName: string) {
    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();

      const job = await this.batchApi.readNamespacedJob({
        name: jobName,
        namespace: this.namespace,
      });

      const coreV1Api = kc.makeApiClient(CoreV1Api);

      const pods = await coreV1Api.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name=${job.metadata.name}`,
      });

      return pods.items.at(0);
    } catch (error) {
      if (error.code.toString() !== "404") {
        throw error;
      }
    }
  }

  private async isNodeOnline(nodeName: string): Promise<boolean> {
    try {
      const node = await this.coreApi.readNode({
        name: nodeName,
      });

      // Check if the node has a Ready condition with status True
      const readyCondition = node.status?.conditions?.find(
        (condition) => condition.type === "Ready",
      );

      return readyCondition?.status === "True";
    } catch (error) {
      this.logger.error(`Failed to check node status for ${nodeName}:`, error);
      // If we can't check the status, assume the node is online to avoid blocking logs
      return true;
    }
  }
}
