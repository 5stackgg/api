import zlib from "zlib";
import archiver from "archiver";
import { Injectable, Logger } from "@nestjs/common";
import { PassThrough, Writable } from "stream";
import { Log, KubeConfig, CoreV1Api, V1Pod } from "@kubernetes/client-node";

@Injectable()
export class LoggingServiceService {
  private coreApi: CoreV1Api;
  private namespace = "5stack";
  private kubeConfig: KubeConfig;

  constructor(protected readonly logger: Logger) {
    this.kubeConfig = new KubeConfig();

    this.kubeConfig.loadFromDefault();

    this.coreApi = this.kubeConfig.makeApiClient(CoreV1Api);
  }

  public async getServiceLogs(
    service: string,
    stream: Writable,
    previous = false,
    download = false,
  ): Promise<void> {
    let archive: archiver.Archiver;

    if (download) {
      archive = archiver("zip", {
        zlib: { level: zlib.constants.Z_NO_COMPRESSION },
      });

      // @ts-ignore
      archive.pipe(stream);
    }

    const pods = await this.getPodsFromService(service);

    for (const pod of pods) {
      await Promise.all([
        this.getLogsForPod(pod, stream, download, previous, 250, archive),
      ]);
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
        stream.destroy();
      });
      stream.on("close", () => {
        podLogs?.abort();
        stream.destroy();
      });
      stream.on("error", () => {
        podLogs?.abort();
        stream.destroy();
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
      this.logger.warn(
        `Failed to get logs for pod ${pod.metadata.name}, container ${containerName}`,
        error,
      );
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

    for (const container of pod.spec.containers) {
      const logStream = new PassThrough();

      logStream.on("end", () => {
        this.logger.log("log stream ended");
        ++totalAdded;
        if (archive && totalAdded == pod.spec.containers.length) {
          void archive.finalize();
        }
        stream.end();
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
        stream.end();
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
}
