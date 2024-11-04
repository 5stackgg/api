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
  ): Promise<() => void> {
    let archive: archiver.Archiver;

    if (download) {
      archive = archiver("zip", {
        zlib: { level: zlib.constants.Z_NO_COMPRESSION },
      });

      // @ts-ignore
      archive.pipe(stream);
    }

    const pods = await this.getPodsFromService(service);

    const aborts: Array<() => void> = [];

    for (const pod of pods) {
      await Promise.all([
        this.getLogsForPod(pod, archive, stream, download, previous, aborts),
      ]);
    }

    return () => {
      for (const abort of aborts) {
        try {
          abort();
        } catch (error) {
          this.logger.error("Failed to abort pod logs", error);
        }
      }
    };
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
    const { body } = await this.coreApi.listNamespacedPod(namespace);
    return body.items;
  }

  private async getLogsForPod(
    pod: V1Pod,
    archive: archiver.Archiver,
    stream: Writable,
    download: boolean,
    previous: boolean,
    aborts: Array<() => void>,
  ) {
    let totalAdded = 0;

    for (const container of pod.spec.containers) {
      const logStream = new PassThrough();

      logStream.on("end", () => {
        ++totalAdded;
        if (archive && totalAdded == pod.spec.containers.length) {
          void archive.finalize();
        }
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

      if (archive) {
        archive.append(logStream, {
          name: `${container.name}.txt`,
        });
      }

      const logApi = new Log(this.kubeConfig);

      const podLogs = await logApi.log(
        this.namespace,
        pod.metadata.name,
        container.name,
        logStream,
        {
          tailLines: 250,
          previous,
          pretty: false,
          timestamps: true,
          follow: download === false,
        },
      );

      aborts.push(() => {
        podLogs.abort();
      });
    }
  }
}
