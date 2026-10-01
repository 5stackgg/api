import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  V1DeleteOptions,
  V1Job,
  V1Node,
  V1NodeSelectorTerm,
  V1ObjectMeta,
  V1PersistentVolume,
  V1PersistentVolumeClaim,
} from "@kubernetes/client-node";
import { HasuraService } from "../hasura/hasura.service";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { GameServerNodeService } from "./game-server-node.service";

export type CleanupRemovedNodesOutput = {
  nodes: number;
  jobs: number;
  volume_claims: number;
  volumes: number;
  failed: number;
  node_delete_forbidden: boolean;
  // Removed nodes that were skipped because they were Ready within the grace
  // period, so they may still come back.
  recently_ready: number;
};

type Inventory = {
  nodes: Map<string, V1Node>;
  jobs: Array<V1Job>;
  volumes: Array<V1PersistentVolume>;
  claims: Map<string, V1PersistentVolumeClaim>;
};

type DeleteOutcome = "deleted" | "gone" | "failed";

// Removing a game server node only deletes its row. This removes what the
// cluster still holds for it: its k8s Node, Jobs, volume claims and volumes.
@Injectable()
export class NodeCleanupService {
  // A node that is still running re-creates its row on its next ping, within
  // 30 s. One that went down may only be restarting, so it keeps everything
  // until it has been NotReady this long. k8s marks a node that went down
  // NotReady within about a minute.
  public static readonly NOT_READY_GRACE_MS = 10 * 60 * 1000;

  private readonly namespace: string;
  private readonly coreApi: CoreV1Api;
  private readonly batchApi: BatchV1Api;

  constructor(
    protected readonly logger: Logger,
    protected readonly config: ConfigService,
    protected readonly hasura: HasuraService,
  ) {
    this.namespace =
      this.config.get<GameServersConfig>("gameServers").namespace;

    const kc = new KubeConfig();
    kc.loadFromDefault();

    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
  }

  // With an id only that node is cleaned. Without one, every node id the
  // cluster still has a labelled Node, a pinned Job or a local volume for is.
  public async cleanupRemovedNodes(
    onlyNodeId?: string,
  ): Promise<CleanupRemovedNodesOutput> {
    const result = NodeCleanupService.emptyResult();

    const inventory = await this.getInventory(onlyNodeId);

    const candidates = onlyNodeId
      ? [onlyNodeId]
      : NodeCleanupService.getCandidates(inventory);

    const registered = await this.getRegisteredNodeIds(candidates);

    let removed = 0;
    let cleaned = 0;
    for (const nodeId of candidates) {
      if (registered.has(nodeId)) {
        if (onlyNodeId) {
          this.logger.log(
            `[node-cleanup] ${nodeId} is registered again, skipping`,
          );
        }
        continue;
      }
      removed++;

      const node = inventory.nodes.get(nodeId);

      // The panel's own host runs game servers too, but its Node is never one
      // to delete, even without a row.
      if (NodeCleanupService.isControlPlane(node)) {
        this.logger.warn(
          `[node-cleanup] ${nodeId} is a control plane node, skipping`,
        );
        continue;
      }

      const recentlyReady = NodeCleanupService.recentlyReady(node);
      if (recentlyReady) {
        result.recently_ready++;
        this.logger.log(`[node-cleanup] ${nodeId} ${recentlyReady}, skipping`);
        continue;
      }

      const counts = await this.cleanupNode(nodeId, node, inventory);
      this.logger.log(
        `[node-cleanup] ${nodeId}: ${NodeCleanupService.describe(counts)}`,
      );
      NodeCleanupService.addTo(result, counts);
      if (
        counts.failed === 0 &&
        !counts.node_delete_forbidden &&
        counts.recently_ready === 0
      ) {
        cleaned++;
      }
    }

    if (!onlyNodeId) {
      this.logger.log(
        `[node-cleanup] sweep cleaned ${cleaned} of ${removed} removed node id(s): ${NodeCleanupService.describe(result)}`,
      );
    }

    return result;
  }

  private async cleanupNode(
    nodeId: string,
    node: V1Node | undefined,
    inventory: Inventory,
  ): Promise<CleanupRemovedNodesOutput> {
    const counts = NodeCleanupService.emptyResult();

    const nodeState = await this.deleteNode(nodeId, node, counts);
    if (nodeState === "replaced") {
      return counts;
    }

    for (const job of inventory.jobs) {
      if (
        NodeCleanupService.ownedJobNodeId(job) !== nodeId ||
        NodeCleanupService.isTerminating(job.metadata)
      ) {
        continue;
      }

      const outcome = await this.deleteObject(
        nodeId,
        `job ${job.metadata.name}`,
        () =>
          this.batchApi.deleteNamespacedJob({
            name: job.metadata.name,
            namespace: this.namespace,
            body: NodeCleanupService.deleteOptions(job.metadata),
          }),
      );
      NodeCleanupService.count(counts, "jobs", outcome);
    }

    // While the Node stays, the pods k8s still lists on it hold its claims and
    // volumes, so deleting them now would only leave them terminating. A host
    // that came back would then create no new ones, and lose them once its
    // pods stopped.
    if (nodeState === "kept") {
      return counts;
    }

    for (const volume of inventory.volumes) {
      if (NodeCleanupService.volumeNodeId(volume) !== nodeId) {
        continue;
      }

      const volumeName = volume.metadata.name;
      const reclaimPolicy = volume.spec.persistentVolumeReclaimPolicy;

      // Releasing a volume with any other policy can have k8s delete or scrub
      // its data.
      if (reclaimPolicy !== "Retain") {
        this.logger.warn(
          `[node-cleanup] ${nodeId}: skipping volume ${volumeName} and its claims, its reclaim policy is ${reclaimPolicy}`,
        );
        continue;
      }

      // A claim in another namespace is not the api's, and deleting its volume
      // would leave that claim lost.
      const claimNamespace = volume.spec.claimRef?.namespace;
      if (claimNamespace && claimNamespace !== this.namespace) {
        this.logger.warn(
          `[node-cleanup] ${nodeId}: skipping volume ${volumeName} and its claims, its claimRef is in namespace ${claimNamespace}`,
        );
        continue;
      }

      let claimFailed = false;
      for (const claim of this.getClaims(volume, inventory.claims)) {
        const outcome = await this.deleteObject(
          nodeId,
          `volume claim ${claim.metadata.name}`,
          () =>
            this.coreApi.deleteNamespacedPersistentVolumeClaim({
              name: claim.metadata.name,
              namespace: this.namespace,
              body: NodeCleanupService.deleteOptions(claim.metadata),
            }),
        );
        NodeCleanupService.count(counts, "volume_claims", outcome);
        claimFailed ||= outcome === "failed";
      }

      // The volume goes only after its claims, so a failed claim leaves both
      // for the next run.
      if (claimFailed || NodeCleanupService.isTerminating(volume.metadata)) {
        continue;
      }

      const outcome = await this.deleteObject(
        nodeId,
        `volume ${volumeName}`,
        () =>
          this.coreApi.deletePersistentVolume({
            name: volumeName,
            body: NodeCleanupService.deleteOptions(volume.metadata),
          }),
      );
      NodeCleanupService.count(counts, "volumes", outcome);
    }

    return counts;
  }

  // The Node goes first. Once it is gone, k8s removes the pods it still lists
  // on it, so the claims and volumes those hold can finish deleting.
  private async deleteNode(
    nodeId: string,
    node: V1Node | undefined,
    counts: CleanupRemovedNodesOutput,
  ): Promise<"gone" | "replaced" | "kept"> {
    if (!node || NodeCleanupService.isTerminating(node.metadata)) {
      return "gone";
    }

    try {
      await this.coreApi.deleteNode({
        name: nodeId,
        body: NodeCleanupService.deleteOptions(node.metadata),
      });
      counts.nodes++;
      return "gone";
    } catch (error) {
      const code = NodeCleanupService.statusCode(error);
      if (code === "404") {
        return "gone";
      }

      // The uid precondition found a newer Node, so the host registered again
      // and keeps everything.
      if (code === "409") {
        counts.recently_ready++;
        this.logger.log(
          `[node-cleanup] ${nodeId} registered a new Node, skipping`,
        );
        return "replaced";
      }

      if (code === "403") {
        counts.node_delete_forbidden = true;
        this.logger.warn(
          `[node-cleanup] ${nodeId}: not allowed to delete the Node, the api ClusterRole needs the delete verb on nodes. Keeping its volumes; run the cleanup in the server settings once git pull && ./update.sh in the panel has applied that ClusterRole`,
        );
      } else {
        counts.failed++;
        this.logger.error(
          `[node-cleanup] ${nodeId}: unable to delete the Node`,
          error?.message ?? error,
        );
      }
      return "kept";
    }
  }

  // Without a full picture nothing is deleted, so a failed read rejects.
  private async getInventory(onlyNodeId?: string): Promise<Inventory> {
    try {
      const [nodes, jobs, volumes, claims] = await Promise.all([
        onlyNodeId
          ? this.readNode(onlyNodeId)
          : this.coreApi.listNode().then(({ items }) => items),
        this.batchApi.listNamespacedJob({ namespace: this.namespace }),
        this.coreApi.listPersistentVolume(),
        this.coreApi.listNamespacedPersistentVolumeClaim({
          namespace: this.namespace,
        }),
      ]);

      return {
        nodes: new Map(nodes.map((node) => [node.metadata.name, node])),
        jobs: jobs.items,
        volumes: volumes.items,
        claims: new Map(
          claims.items.map((claim) => [claim.metadata.name, claim]),
        ),
      };
    } catch (error) {
      this.logger.error(
        `[node-cleanup] unable to list cluster objects`,
        error?.message ?? error,
      );
      throw new Error("unable to list cluster objects");
    }
  }

  private async readNode(name: string): Promise<Array<V1Node>> {
    try {
      return [await this.coreApi.readNode({ name })];
    } catch (error) {
      if (NodeCleanupService.statusCode(error) === "404") {
        return [];
      }
      throw error;
    }
  }

  private async getRegisteredNodeIds(
    nodeIds: Array<string>,
  ): Promise<Set<string>> {
    if (nodeIds.length === 0) {
      return new Set();
    }

    try {
      const { game_server_nodes } = await this.hasura.query({
        game_server_nodes: {
          __args: {
            where: {
              id: {
                _in: nodeIds,
              },
            },
          },
          id: true,
        },
      });

      return new Set(game_server_nodes.map(({ id }) => id));
    } catch (error) {
      this.logger.error(
        `[node-cleanup] unable to read game server nodes`,
        error?.message ?? error,
      );
      throw new Error("unable to read game server nodes");
    }
  }

  // The claim the volume is bound to, plus the `<volume>-claim` the api
  // creates for it, which may never have bound. A name alone is not enough: a
  // released volume keeps the claimRef of its deleted claim, and a newer claim
  // with that name can hold another volume. So a claim counts only when it is
  // bound, or pre-bound like the api's, to this volume, and the one the
  // claimRef names must also have its uid, when the claimRef records one.
  private getClaims(
    volume: V1PersistentVolume,
    claims: Map<string, V1PersistentVolumeClaim>,
  ): Array<V1PersistentVolumeClaim> {
    const found = new Map<string, V1PersistentVolumeClaim>();

    const add = (name: string, uid?: string) => {
      const claim = claims.get(name);
      if (
        claim &&
        claim.spec?.volumeName === volume.metadata.name &&
        (!uid || claim.metadata.uid === uid) &&
        !NodeCleanupService.isTerminating(claim.metadata)
      ) {
        found.set(name, claim);
      }
    };

    add(`${volume.metadata.name}-claim`);

    const claimRef = volume.spec.claimRef;
    if (claimRef?.namespace === this.namespace && claimRef.name) {
      add(claimRef.name, claimRef.uid);
    }

    return [...found.values()];
  }

  // A 404 means already gone and a 409 that the uid precondition found a
  // newer object with the same name, so neither is a delete or a failure.
  private async deleteObject(
    nodeId: string,
    what: string,
    request: () => Promise<unknown>,
  ): Promise<DeleteOutcome> {
    try {
      await request();
      return "deleted";
    } catch (error) {
      if (NodeCleanupService.isGone(error)) {
        return "gone";
      }

      this.logger.error(
        `[node-cleanup] ${nodeId}: unable to delete ${what}`,
        error?.message ?? error,
      );
      return "failed";
    }
  }

  private static getCandidates(inventory: Inventory): Array<string> {
    const nodeIds = new Set<string>();

    for (const [name, node] of inventory.nodes) {
      if (node.metadata.labels?.["5stack-id"]) {
        nodeIds.add(name);
      }
    }

    for (const job of inventory.jobs) {
      const nodeId = NodeCleanupService.ownedJobNodeId(job);
      if (nodeId) {
        nodeIds.add(nodeId);
      }
    }

    for (const volume of inventory.volumes) {
      const nodeId = NodeCleanupService.volumeNodeId(volume);
      if (nodeId) {
        nodeIds.add(nodeId);
      }
    }

    return [...nodeIds].sort();
  }

  // Only the Jobs the api runs for the node itself. Match server Jobs are
  // pinned to a node too, but they belong to the match flow.
  private static ownedJobNodeId(job: V1Job): string | null {
    const nodeId = NodeCleanupService.pinnedNodeId(job);
    if (!nodeId) {
      return null;
    }

    if (
      job.metadata.name === GameServerNodeService.GET_UPDATE_JOB_NAME(nodeId) ||
      job.metadata.name ===
        GameServerNodeService.GET_UPDATE_JOB_NAME(nodeId, "csgo")
    ) {
      return nodeId;
    }

    // The validation Job is named after the build, so only its label and pin
    // tie it to this node.
    const app =
      job.metadata.labels?.app ?? job.spec?.template?.metadata?.labels?.app;
    if (app === "validate-gamedata" || app === "game-streamer") {
      return nodeId;
    }

    return null;
  }

  private static pinnedNodeId(job: V1Job): string | null {
    return NodeCleanupService.pinnedValue(
      job.spec?.template?.spec?.affinity?.nodeAffinity
        ?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms,
      "kubernetes.io/hostname",
    );
  }

  private static volumeNodeId(volume: V1PersistentVolume): string | null {
    if (volume.spec?.storageClassName !== "local-storage") {
      return null;
    }

    return NodeCleanupService.pinnedValue(
      volume.spec.nodeAffinity?.required?.nodeSelectorTerms,
      "5stack-id",
    );
  }

  // Terms are ORed, so an object is pinned only when every term requires the
  // key to be exactly the same one value.
  private static pinnedValue(
    terms: Array<V1NodeSelectorTerm> | undefined,
    key: string,
  ): string | null {
    let pinned: string | null = null;

    for (const term of terms ?? []) {
      const values = term.matchExpressions?.find(
        (expression) => expression.key === key && expression.operator === "In",
      )?.values;

      if (values?.length !== 1 || (pinned !== null && pinned !== values[0])) {
        return null;
      }

      pinned = values[0];
    }

    return pinned;
  }

  private static isControlPlane(node?: V1Node): boolean {
    const labels = node?.metadata?.labels ?? {};
    return (
      "node-role.kubernetes.io/control-plane" in labels ||
      "node-role.kubernetes.io/master" in labels
    );
  }

  // Why the node still counts as recently Ready, or null once it has been
  // NotReady for the grace period. A missing Node, or one without a transition
  // time, does not count.
  private static recentlyReady(node?: V1Node): string | null {
    const ready = node?.status?.conditions?.find(
      (condition) => condition.type === "Ready",
    );
    if (ready?.status === "True") {
      return "is still Ready";
    }

    const notReadyFor =
      Date.now() - new Date(ready?.lastTransitionTime ?? NaN).getTime();
    if (notReadyFor < NodeCleanupService.NOT_READY_GRACE_MS) {
      return `went NotReady less than ${NodeCleanupService.NOT_READY_GRACE_MS / 60000} minutes ago`;
    }

    return null;
  }

  private static isTerminating(metadata?: V1ObjectMeta): boolean {
    return !!metadata?.deletionTimestamp;
  }

  // The API server ignores query params once a body is sent, so options go
  // in the body. The uid keeps the delete off a newer object with the name.
  private static deleteOptions(metadata: V1ObjectMeta): V1DeleteOptions {
    return {
      propagationPolicy: "Background",
      ...(metadata.uid ? { preconditions: { uid: metadata.uid } } : {}),
    };
  }

  private static statusCode(error: { code?: number | string }) {
    return error?.code?.toString();
  }

  private static isGone(error: { code?: number | string }) {
    const code = NodeCleanupService.statusCode(error);
    return code === "404" || code === "409";
  }

  private static count(
    counts: CleanupRemovedNodesOutput,
    key: "jobs" | "volume_claims" | "volumes",
    outcome: DeleteOutcome,
  ) {
    if (outcome === "deleted") {
      counts[key]++;
    } else if (outcome === "failed") {
      counts.failed++;
    }
  }

  private static emptyResult(): CleanupRemovedNodesOutput {
    return {
      nodes: 0,
      jobs: 0,
      volume_claims: 0,
      volumes: 0,
      failed: 0,
      node_delete_forbidden: false,
      recently_ready: 0,
    };
  }

  private static addTo(
    total: CleanupRemovedNodesOutput,
    counts: CleanupRemovedNodesOutput,
  ) {
    total.nodes += counts.nodes;
    total.jobs += counts.jobs;
    total.volume_claims += counts.volume_claims;
    total.volumes += counts.volumes;
    total.failed += counts.failed;
    total.node_delete_forbidden ||= counts.node_delete_forbidden;
    total.recently_ready += counts.recently_ready;
  }

  private static describe(counts: CleanupRemovedNodesOutput): string {
    return (
      `deleted ${counts.jobs} job(s), ${counts.volume_claims} volume claim(s), ` +
      `${counts.volumes} volume(s) and ${counts.nodes} node(s), ${counts.failed} failed` +
      (counts.node_delete_forbidden ? ", node delete forbidden" : "") +
      (counts.recently_ready > 0
        ? `, ${counts.recently_ready} recently Ready`
        : "")
    );
  }
}
