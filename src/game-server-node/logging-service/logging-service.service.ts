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
export class LoggingServiceService {
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
    previous = false,
    download = false,
    isJob = false,
  ): Promise<void> {
    let archive: archiver.Archiver;

    if (download) {
      archive = archiver("zip", {
        zlib: { level: zlib.constants.Z_NO_COMPRESSION },
      });

      // @ts-ignore
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

    for (const pod of pods) {
      await Promise.all([
        this.getLogsForPod(pod, stream, download, previous, 250, archive),
      ]);
    }

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
    const postList = await this.coreApi.listNamespacedPod({
      namespace,
    });
    return postList.items;
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
    tailLines: number,
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
          follow: download === false,
          tailLines,
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
    tailLines = 1,
    archive?: archiver.Archiver,
  ) {
    let totalAdded = 0;
    let streamEnded = false;

    const endStream = () => {
      if (!streamEnded) {
        streamEnded = true;
        stream.end();
      }
    };

    for (const container of pod.spec.containers) {
      const logStream = new PassThrough();

      logStream.on("end", () => {
        this.logger.log("log stream ended");
        ++totalAdded;
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

        for (let log of text.split(/\n/)) {
          const timestampMatch = log.match(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/,
          );
          const timestamp = timestampMatch ? timestampMatch[0] : "";
          log = log.replace(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/,
            "",
          );

          stream.write(
            JSON.stringify({
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
        this.logger.log("log stream closed");
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
      );
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
