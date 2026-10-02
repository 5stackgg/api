import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  V1Node,
  V1NodeSelectorTerm,
} from "@kubernetes/client-node";
import { HasuraService } from "src/hasura/hasura.service";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";

// A host that went down may only be restarting, and once its Node is deleted
// its kubelet does not register again until k3s-agent restarts.
const NOT_READY_GRACE_MS = 10 * 60 * 1000;

// Jobs the api pins to a node for the node itself. Match server jobs are left
// alone.
const NODE_JOB_APPS = [
  "update-cs-server",
  "validate-gamedata",
  "game-streamer",
];

/**
 * Cleans up after game server nodes that were removed from the panel. A node
 * counts as removed once it has no game_server_nodes row; a host that is still
 * running re-creates its row on its next ping.
 *
 * 1. The Node of a removed node is deleted once it has been NotReady for
 *    NOT_READY_GRACE_MS. Control plane Nodes are never deleted.
 * 2. Jobs, claims and volumes pinned to a node id that has neither a row nor a
 *    Node are deleted. Files on the node's disk are kept (the volumes are
 *    Retain). A Node deleted in step 1 is still counted here, so its pods are
 *    gone by the next run.
 */
@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class CleanupRemovedNodes extends WorkerHost {
  private readonly namespace: string;

  constructor(
    private readonly hasura: HasuraService,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {
    super();
    this.namespace =
      this.config.get<GameServersConfig>("gameServers").namespace;
  }

  async process(): Promise<void> {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    const batch = kc.makeApiClient(BatchV1Api);

    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: { id: true },
    });
    const rows = new Set(game_server_nodes.map(({ id }) => id));

    const { items: nodes } = await core.listNode();
    const present = new Set(
      nodes.flatMap((node) => [
        node.metadata.name,
        node.metadata.labels?.["5stack-id"],
      ]),
    );
    const isRemoved = (id?: string) =>
      !!id && !rows.has(id) && !present.has(id);

    for (const node of nodes) {
      if (this.isDeadRemovedNode(node, rows)) {
        await this.remove(`Node ${node.metadata.name}`, () =>
          core.deleteNode({
            name: node.metadata.name,
            body: { preconditions: { uid: node.metadata.uid } },
          }),
        );
      }
    }

    const { items: jobs } = await batch.listNamespacedJob({
      namespace: this.namespace,
    });
    for (const job of jobs) {
      const template = job.spec?.template;
      if (
        job.metadata.deletionTimestamp ||
        !NODE_JOB_APPS.includes(template?.metadata?.labels?.app) ||
        !isRemoved(
          pinnedTo(
            template?.spec?.affinity?.nodeAffinity
              ?.requiredDuringSchedulingIgnoredDuringExecution
              ?.nodeSelectorTerms,
            "kubernetes.io/hostname",
          ),
        )
      ) {
        continue;
      }
      await this.remove(`Job ${job.metadata.name}`, () =>
        batch.deleteNamespacedJob({
          name: job.metadata.name,
          namespace: this.namespace,
          body: {
            propagationPolicy: "Background",
            preconditions: { uid: job.metadata.uid },
          },
        }),
      );
    }

    const { items: volumes } = await core.listPersistentVolume();
    for (const volume of volumes) {
      const name = volume.metadata.name;
      const claimName = `${name}-claim`;
      const claimRef = volume.spec?.claimRef;
      if (
        volume.metadata.deletionTimestamp ||
        volume.spec?.storageClassName !== "local-storage" ||
        volume.spec.persistentVolumeReclaimPolicy !== "Retain" ||
        (claimRef &&
          (claimRef.namespace !== this.namespace ||
            claimRef.name !== claimName)) ||
        !isRemoved(
          pinnedTo(
            volume.spec.nodeAffinity?.required?.nodeSelectorTerms,
            "5stack-id",
          ),
        )
      ) {
        continue;
      }

      const claim = await core
        .readNamespacedPersistentVolumeClaim({
          name: claimName,
          namespace: this.namespace,
        })
        .catch((): undefined => undefined);
      if (claim?.spec?.volumeName === name) {
        await this.remove(`PersistentVolumeClaim ${claimName}`, () =>
          core.deleteNamespacedPersistentVolumeClaim({
            name: claimName,
            namespace: this.namespace,
            body: { preconditions: { uid: claim.metadata.uid } },
          }),
        );
      }

      await this.remove(`PersistentVolume ${name}`, () =>
        core.deletePersistentVolume({
          name,
          body: { preconditions: { uid: volume.metadata.uid } },
        }),
      );
    }
  }

  private isDeadRemovedNode(node: V1Node, rows: Set<string>) {
    const labels = node.metadata.labels ?? {};
    const id = labels["5stack-id"];
    if (
      !id ||
      rows.has(id) ||
      "node-role.kubernetes.io/control-plane" in labels ||
      "node-role.kubernetes.io/master" in labels
    ) {
      return false;
    }

    const ready = node.status?.conditions?.find(({ type }) => type === "Ready");
    if (ready?.status === "True") {
      return false;
    }

    const since = new Date(
      ready?.lastTransitionTime ?? node.metadata.creationTimestamp,
    ).getTime();
    return Date.now() - since >= NOT_READY_GRACE_MS;
  }

  private async remove(what: string, remove: () => Promise<unknown>) {
    try {
      await remove();
      this.logger.log(`[node cleanup] removed ${what}`);
    } catch (error) {
      const code = Number(error?.code);
      // already gone, or replaced by a newer object of the same name
      if (code === 404 || code === 409) {
        return;
      }
      this.logger.warn(
        `[node cleanup] could not remove ${what}: ${
          code === 403
            ? "forbidden, run ./update.sh on the panel to update the api's permissions"
            : error?.message
        }`,
      );
    }
  }
}

function pinnedTo(terms: V1NodeSelectorTerm[] | undefined, key: string) {
  return terms
    ?.flatMap((term) => term.matchExpressions ?? [])
    .find(
      (expression) => expression.key === key && expression.operator === "In",
    )?.values?.[0];
}
