const listNode = jest.fn();
const readNode = jest.fn();
const deleteNode = jest.fn();
const listPersistentVolume = jest.fn();
const deletePersistentVolume = jest.fn();
const listNamespacedPersistentVolumeClaim = jest.fn();
const deleteNamespacedPersistentVolumeClaim = jest.fn();
const listNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    listNamespacedJob = listNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNode = listNode;
    readNode = readNode;
    deleteNode = deleteNode;
    listPersistentVolume = listPersistentVolume;
    deletePersistentVolume = deletePersistentVolume;
    listNamespacedPersistentVolumeClaim = listNamespacedPersistentVolumeClaim;
    deleteNamespacedPersistentVolumeClaim =
      deleteNamespacedPersistentVolumeClaim;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
}));

import {
  CleanupRemovedNodesOutput,
  NodeCleanupService,
} from "./node-cleanup.service";

describe("NodeCleanupService removed node cleanup", () => {
  const NAMESPACE = "test";
  const NODE = "a1b2c3d4";
  const OTHER_NODE = "e5f6a7b8";

  let service: NodeCleanupService;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let hasura: { query: jest.Mock };
  let nodes: Array<Record<string, any>>;
  let jobs: Array<Record<string, any>>;
  let volumes: Array<Record<string, any>>;
  let claims: Array<Record<string, any>>;
  let rows: Array<string>;
  let deletes: Array<string>;

  const result = (counts: Partial<CleanupRemovedNodesOutput> = {}) => ({
    nodes: 0,
    jobs: 0,
    volume_claims: 0,
    volumes: 0,
    failed: 0,
    node_delete_forbidden: false,
    recently_ready: 0,
    ...counts,
  });

  const apiError = (code: number) =>
    Object.assign(new Error(`HTTP-Code: ${code}`), { code });

  // Records every delete in call order, and rejects the ones named in
  // `errors` with that status code.
  const recordDeletes =
    (kind: string, errors: Record<string, number> = {}) =>
    async ({ name }: { name: string }) => {
      deletes.push(`${kind} ${name}`);
      if (errors[name]) {
        throw apiError(errors[name]);
      }
      return {};
    };

  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60 * 1000);

  // Went to `ready` an hour ago unless told otherwise, so past the grace
  // period. A null time leaves it out.
  const node = (
    name: string,
    ready: "True" | "False" | "Unknown",
    metadata: Record<string, any> = {},
    lastTransitionTime: Date | null = minutesAgo(60),
  ) => ({
    metadata: {
      name,
      uid: `node-uid-${name}`,
      labels: { "5stack-id": name },
      ...metadata,
    },
    status: {
      conditions: [
        {
          type: "Ready",
          status: ready,
          ...(lastTransitionTime ? { lastTransitionTime } : {}),
        },
      ],
    },
  });

  const hostnamePin = (values: Array<string>) => ({
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: "kubernetes.io/hostname", operator: "In", values },
            ],
          },
        ],
      },
    },
  });

  const job = (
    name: string,
    labels: Record<string, string>,
    podSpec: Record<string, any>,
    metadata: Record<string, any> = {},
  ) => ({
    metadata: { name, uid: `job-uid-${name}`, labels, ...metadata },
    spec: { template: { metadata: { labels }, spec: podSpec } },
  });

  const updateJob = (nodeId: string, game = "cs") =>
    job(
      `update-${game}-server-${nodeId.replaceAll(".", "-")}`,
      { app: "update-cs-server" },
      { affinity: hostnamePin([nodeId]) },
    );

  // The api only labels the pod template of the validation Job.
  const validateJob = (name: string, nodeId: string) => ({
    metadata: { name, uid: `job-uid-${name}` },
    spec: {
      template: {
        metadata: { labels: { app: "validate-gamedata" } },
        spec: { affinity: hostnamePin([nodeId]) },
      },
    },
  });

  const streamerJob = (name: string, podSpec: Record<string, any>) =>
    job(name, { app: "game-streamer", role: "live" }, podSpec);

  const volumeTerm = (values: Array<string>, key = "5stack-id") => ({
    matchExpressions: [{ key, operator: "In", values }],
  });

  const volume = (
    name: string,
    nodeId: string,
    spec: Record<string, any> = {},
    metadata: Record<string, any> = {},
  ) => ({
    metadata: { name, uid: `pv-uid-${name}`, ...metadata },
    spec: {
      storageClassName: "local-storage",
      persistentVolumeReclaimPolicy: "Retain",
      claimRef: { namespace: NAMESPACE, name: `${name}-claim` },
      nodeAffinity: {
        required: { nodeSelectorTerms: [volumeTerm([nodeId])] },
      },
      ...spec,
    },
  });

  // A claim bound to `volumeName`, or pre-bound to it the way the api creates
  // its own `<volume>-claim`.
  const claim = (
    name: string,
    volumeName = name.replace(/-claim$/, ""),
    metadata: Record<string, any> = {},
  ) => ({
    metadata: {
      name,
      namespace: NAMESPACE,
      uid: `pvc-uid-${name}`,
      ...metadata,
    },
    spec: { volumeName },
  });

  // What a node the api set up leaves behind: its two update Jobs and a
  // volume with its claim.
  const leftoversOf = (nodeId: string) => {
    jobs.push(updateJob(nodeId), updateJob(nodeId, "csgo"));
    volumes.push(volume(`demos-${nodeId}`, nodeId));
    claims.push(claim(`demos-${nodeId}-claim`));
  };

  const deletesOfLeftovers = (nodeId: string) => [
    `job update-cs-server-${nodeId}`,
    `job update-csgo-server-${nodeId}`,
    `claim demos-${nodeId}-claim`,
    `volume demos-${nodeId}`,
  ];

  beforeEach(() => {
    for (const fn of [
      listNode,
      readNode,
      deleteNode,
      listPersistentVolume,
      deletePersistentVolume,
      listNamespacedPersistentVolumeClaim,
      deleteNamespacedPersistentVolumeClaim,
      listNamespacedJob,
      deleteNamespacedJob,
    ]) {
      fn.mockReset();
    }

    nodes = [];
    jobs = [];
    volumes = [];
    claims = [];
    rows = [];
    deletes = [];

    listNode.mockImplementation(async () => ({ items: nodes }));
    readNode.mockImplementation(async ({ name }: { name: string }) => {
      const found = nodes.find((candidate) => candidate.metadata.name === name);
      if (!found) {
        throw apiError(404);
      }
      return found;
    });
    listNamespacedJob.mockImplementation(async () => ({ items: jobs }));
    listPersistentVolume.mockImplementation(async () => ({ items: volumes }));
    listNamespacedPersistentVolumeClaim.mockImplementation(async () => ({
      items: claims,
    }));

    deleteNamespacedJob.mockImplementation(recordDeletes("job"));
    deleteNamespacedPersistentVolumeClaim.mockImplementation(
      recordDeletes("claim"),
    );
    deletePersistentVolume.mockImplementation(recordDeletes("volume"));
    deleteNode.mockImplementation(recordDeletes("node"));

    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    hasura = {
      query: jest.fn(async (request: any) => ({
        game_server_nodes: request.game_server_nodes.__args.where.id._in
          .filter((id: string) => rows.includes(id))
          .map((id: string) => ({ id })),
      })),
    };

    service = new NodeCleanupService(
      logger as any,
      {
        get: jest.fn((key: string) =>
          key === "gameServers" ? { namespace: NAMESPACE } : {},
        ),
      } as any,
      hasura as any,
    );
  });

  it("cleans a removed NotReady node: its Node, then its Jobs, then each volume's claims before the volume", async () => {
    nodes.push(node(NODE, "Unknown"), node(OTHER_NODE, "True"));
    rows.push(OTHER_NODE);
    jobs.push(
      updateJob(NODE),
      updateJob(NODE, "csgo"),
      validateJob("validate-gamedata-21000000-public", NODE),
      streamerJob("streamer-live-1", { affinity: hostnamePin([NODE]) }),
    );
    volumes.push(
      volume(`demos-${NODE}`, NODE),
      volume(`steamcmd-${NODE}`, NODE),
      // not bound yet, so only the api's claim, pre-bound to it, is its claim
      volume(`serverfiles-${NODE}`, NODE, { claimRef: undefined }),
    );
    claims.push(
      claim(`demos-${NODE}-claim`),
      claim(`steamcmd-${NODE}-claim`),
      claim(`serverfiles-${NODE}-claim`),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ nodes: 1, jobs: 4, volume_claims: 3, volumes: 3 }),
    );

    expect(deletes).toEqual([
      `node ${NODE}`,
      `job update-cs-server-${NODE}`,
      `job update-csgo-server-${NODE}`,
      "job validate-gamedata-21000000-public",
      "job streamer-live-1",
      `claim demos-${NODE}-claim`,
      `volume demos-${NODE}`,
      `claim steamcmd-${NODE}-claim`,
      `volume steamcmd-${NODE}`,
      `claim serverfiles-${NODE}-claim`,
      `volume serverfiles-${NODE}`,
    ]);

    expect(hasura.query).toHaveBeenCalledWith({
      game_server_nodes: {
        __args: { where: { id: { _in: [NODE, OTHER_NODE] } } },
        id: true,
      },
    });

    // Jobs would orphan their pods without Background propagation, and the
    // uid keeps each delete off a newer object with the same name.
    expect(deleteNamespacedJob).toHaveBeenCalledWith({
      name: `update-cs-server-${NODE}`,
      namespace: NAMESPACE,
      body: {
        propagationPolicy: "Background",
        preconditions: { uid: `job-uid-update-cs-server-${NODE}` },
      },
    });
    expect(deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: `demos-${NODE}-claim`,
      namespace: NAMESPACE,
      body: {
        propagationPolicy: "Background",
        preconditions: { uid: `pvc-uid-demos-${NODE}-claim` },
      },
    });
    expect(deletePersistentVolume).toHaveBeenCalledWith({
      name: `demos-${NODE}`,
      body: {
        propagationPolicy: "Background",
        preconditions: { uid: `pv-uid-demos-${NODE}` },
      },
    });
    expect(deleteNode).toHaveBeenCalledWith({
      name: NODE,
      body: {
        propagationPolicy: "Background",
        preconditions: { uid: `node-uid-${NODE}` },
      },
    });
  });

  it("cleans the leftovers of a removed node whose k8s Node is already gone", async () => {
    leftoversOf(NODE);
    jobs.push(
      streamerJob("streamer-live-1", { affinity: hostnamePin([NODE]) }),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ jobs: 3, volume_claims: 1, volumes: 1 }),
    );

    expect(deletes).toEqual([
      `job update-cs-server-${NODE}`,
      `job update-csgo-server-${NODE}`,
      "job streamer-live-1",
      `claim demos-${NODE}-claim`,
      `volume demos-${NODE}`,
    ]);
    expect(deleteNode).not.toHaveBeenCalled();
  });

  it("removes the labelled Node of a removed node that has nothing else left", async () => {
    nodes.push(node(NODE, "False"));

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ nodes: 1 }),
    );

    expect(deletes).toEqual([`node ${NODE}`]);
  });

  it("skips a Ready node without a row and reports it, since it may still be running", async () => {
    nodes.push(node(NODE, "True", {}, minutesAgo(60 * 24)));
    leftoversOf(NODE);

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ recently_ready: 1 }),
    );
    await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
      result({ recently_ready: 1 }),
    );

    expect(deletes).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE} is still Ready, skipping`,
    );
  });

  it.each(["False", "Unknown"] as const)(
    "keeps a node that went %s less than 10 minutes ago, since it may only be restarting",
    async (ready) => {
      nodes.push(node(NODE, ready, {}, minutesAgo(9)));
      leftoversOf(NODE);

      await expect(service.cleanupRemovedNodes()).resolves.toEqual(
        result({ recently_ready: 1 }),
      );
      await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
        result({ recently_ready: 1 }),
      );

      expect(deletes).toEqual([]);
      expect(logger.log).toHaveBeenCalledWith(
        `[node-cleanup] ${NODE} went NotReady less than 10 minutes ago, skipping`,
      );
    },
  );

  it.each([
    ["10 minutes ago", minutesAgo(10)],
    ["at an unknown time", null],
  ])(
    "cleans a node that went NotReady %s",
    async (_when, lastTransitionTime) => {
      nodes.push(node(NODE, "Unknown", {}, lastTransitionTime));
      leftoversOf(NODE);

      await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
        result({ nodes: 1, jobs: 2, volume_claims: 1, volumes: 1 }),
      );

      expect(deletes).toEqual([`node ${NODE}`, ...deletesOfLeftovers(NODE)]);
    },
  );

  it.each([
    "node-role.kubernetes.io/control-plane",
    "node-role.kubernetes.io/master",
  ])(
    "never cleans the control plane node, even without a row (%s)",
    async (role) => {
      nodes.push(
        node(NODE, "Unknown", {
          labels: { "5stack-id": NODE, [role]: "true" },
        }),
      );
      leftoversOf(NODE);

      await expect(service.cleanupRemovedNodes()).resolves.toEqual(result());
      await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
        result(),
      );

      expect(deletes).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        `[node-cleanup] ${NODE} is a control plane node, skipping`,
      );
    },
  );

  it("skips a node that still has a row", async () => {
    nodes.push(node(NODE, "Unknown"));
    rows.push(NODE);
    leftoversOf(NODE);

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(result());
    await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(result());

    expect(deletes).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE} is registered again, skipping`,
    );
  });

  it("never deletes a NotReady Node that is not a game server node", async () => {
    nodes.push(node("k3s-worker", "Unknown", { labels: {} }));

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(result());

    expect(deletes).toEqual([]);
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("only deletes Retain local volumes pinned to the removed node, with their claims", async () => {
    nodes.push(node(NODE, "Unknown"), node(OTHER_NODE, "True"));
    rows.push(OTHER_NODE);
    volumes.push(
      volume(`steamcmd-${NODE}`, NODE),
      volume(`serverfiles-${OTHER_NODE}`, OTHER_NODE),
      // the panel's database volume is local too, but pinned by its own label
      volume("timescaledb-pv", "true", {
        claimRef: { namespace: NAMESPACE, name: "timescaledb-pvc" },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [volumeTerm(["true"], "5stack-timescaledb")],
          },
        },
      }),
      volume(`longhorn-${NODE}`, NODE, { storageClassName: "longhorn" }),
      volume(`demos-${NODE}`, NODE, {
        persistentVolumeReclaimPolicy: "Delete",
      }),
      // terms are ORed, so this volume can also live on the other node
      volume(`either-${NODE}`, NODE, {
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [volumeTerm([NODE]), volumeTerm([OTHER_NODE])],
          },
        },
      }),
      volume(`shared-${NODE}`, NODE, {
        nodeAffinity: {
          required: { nodeSelectorTerms: [volumeTerm([NODE, OTHER_NODE])] },
        },
      }),
    );
    claims.push(
      claim(`steamcmd-${NODE}-claim`),
      claim(`serverfiles-${OTHER_NODE}-claim`),
      claim("timescaledb-pvc", "timescaledb-pv"),
      claim(`longhorn-${NODE}-claim`),
      claim(`demos-${NODE}-claim`),
      claim(`either-${NODE}-claim`),
      claim(`shared-${NODE}-claim`),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ nodes: 1, volume_claims: 1, volumes: 1 }),
    );

    expect(deletes).toEqual([
      `node ${NODE}`,
      `claim steamcmd-${NODE}-claim`,
      `volume steamcmd-${NODE}`,
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE}: skipping volume demos-${NODE} and its claims, its reclaim policy is Delete`,
    );
  });

  it("deletes the claim a volume is bound to and the api's own claim once each, in the api namespace only", async () => {
    volumes.push(
      volume(`demos-${NODE}`, NODE),
      volume(`steamcmd-${NODE}`, NODE, {
        claimRef: {
          namespace: NAMESPACE,
          name: "steamcmd-restore",
          uid: "pvc-uid-steamcmd-restore",
        },
      }),
      // released: its claim is already gone
      volume(`serverfiles-csgo-${NODE}`, NODE),
    );
    claims.push(
      claim(`demos-${NODE}-claim`),
      // pre-bound to its volume, which an operator's claim holds instead
      claim(`steamcmd-${NODE}-claim`),
      claim("steamcmd-restore", `steamcmd-${NODE}`),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ volume_claims: 3, volumes: 3 }),
    );

    expect(deletes).toEqual([
      `claim demos-${NODE}-claim`,
      `volume demos-${NODE}`,
      `claim steamcmd-${NODE}-claim`,
      "claim steamcmd-restore",
      `volume steamcmd-${NODE}`,
      `volume serverfiles-csgo-${NODE}`,
    ]);
    for (const [request] of deleteNamespacedPersistentVolumeClaim.mock.calls) {
      expect(request.namespace).toBe(NAMESPACE);
    }
  });

  it("keeps a volume whose claimRef is in another namespace, with its claims", async () => {
    volumes.push(
      volume(`demos-${NODE}`, NODE),
      // pre-bound by name only to a claim in another namespace, so no uid
      volume(`serverfiles-${NODE}`, NODE, {
        claimRef: { namespace: "backups", name: "serverfiles-copy" },
      }),
    );
    claims.push(
      claim(`demos-${NODE}-claim`),
      claim(`serverfiles-${NODE}-claim`),
      // the name of the claim the volume is bound to, even pre-bound to the
      // volume, but in the api namespace and not the claimRef's
      claim("serverfiles-copy", `serverfiles-${NODE}`),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ volume_claims: 1, volumes: 1 }),
    );

    expect(deletes).toEqual([
      `claim demos-${NODE}-claim`,
      `volume demos-${NODE}`,
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE}: skipping volume serverfiles-${NODE} and its claims, its claimRef is in namespace backups`,
    );
  });

  it("leaves a claim alone that only shares a name with a volume's claim", async () => {
    volumes.push(
      // released: its claimRef still names the restore claim deleted since
      volume(`steamcmd-${NODE}`, NODE, {
        claimRef: {
          namespace: NAMESPACE,
          name: "steamcmd-restore",
          uid: "pvc-uid-deleted-steamcmd-restore",
        },
      }),
      volume(`demos-${NODE}`, NODE),
      volume(`serverfiles-${NODE}`, NODE, {
        claimRef: {
          namespace: NAMESPACE,
          name: "serverfiles-restore",
          uid: "pvc-uid-deleted-serverfiles-restore",
        },
      }),
    );
    claims.push(
      // a newer restore claim with the old name, bound to another node's
      // volume, which may not even retain its data
      claim("steamcmd-restore", `steamcmd-${OTHER_NODE}`),
      // named like the api's claim for the volume, but bound to another one
      claim(`demos-${NODE}-claim`, `demos-${OTHER_NODE}`),
      // pre-bound to the volume, but not the claim its claimRef names
      claim("serverfiles-restore", `serverfiles-${NODE}`),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ volumes: 3 }),
    );

    expect(deletes).toEqual([
      `volume steamcmd-${NODE}`,
      `volume demos-${NODE}`,
      `volume serverfiles-${NODE}`,
    ]);
    expect(deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it("leaves match server Jobs, other Jobs and the Jobs of other nodes alone", async () => {
    nodes.push(node(NODE, "Unknown"), node(OTHER_NODE, "True"));
    rows.push(OTHER_NODE);
    jobs.push(
      updateJob(NODE),
      job(
        "m-0b6f3c9e-4a57-4d2f-9f0e-3c2b1a0d9e8f",
        { app: "game-server", role: "match" },
        { affinity: hostnamePin([NODE]) },
      ),
      job(
        "map-assets-de-dust2",
        { app: "map-assets" },
        { affinity: hostnamePin([NODE]) },
      ),
      updateJob(OTHER_NODE),
      streamerJob("streamer-live-2", { affinity: hostnamePin([OTHER_NODE]) }),
      // not pinned to a single node
      streamerJob("streamer-live-3", {
        affinity: hostnamePin([NODE, OTHER_NODE]),
      }),
      streamerJob("streamer-live-4", {}),
      // the api pins its Jobs by affinity, never by nodeName
      streamerJob("streamer-live-5", { nodeName: NODE }),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ nodes: 1, jobs: 1 }),
    );

    expect(deletes).toEqual([`node ${NODE}`, `job update-cs-server-${NODE}`]);
  });

  it("finds the update Jobs of a node id with dots by their sanitized name", async () => {
    const dottedNode = "gpu.lan";
    jobs.push(updateJob(dottedNode), updateJob(dottedNode, "csgo"));

    await expect(service.cleanupRemovedNodes(dottedNode)).resolves.toEqual(
      result({ jobs: 2 }),
    );

    expect(deletes).toEqual([
      "job update-cs-server-gpu-lan",
      "job update-csgo-server-gpu-lan",
    ]);
  });

  it("does not count objects that are already gone or were replaced", async () => {
    nodes.push(node(NODE, "Unknown"));
    leftoversOf(NODE);
    deleteNamespacedJob.mockImplementation(
      recordDeletes("job", {
        [`update-cs-server-${NODE}`]: 404,
        [`update-csgo-server-${NODE}`]: 409,
      }),
    );
    deleteNamespacedPersistentVolumeClaim.mockImplementation(
      recordDeletes("claim", { [`demos-${NODE}-claim`]: 404 }),
    );
    deletePersistentVolume.mockImplementation(
      recordDeletes("volume", { [`demos-${NODE}`]: 404 }),
    );
    deleteNode.mockImplementation(recordDeletes("node", { [NODE]: 404 }));

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(result());

    // a claim that is already gone does not hold its volume back
    expect(deletes).toEqual([`node ${NODE}`, ...deletesOfLeftovers(NODE)]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps everything when the host registered a new Node since the listing", async () => {
    nodes.push(node(NODE, "Unknown"));
    leftoversOf(NODE);
    deleteNode.mockImplementation(recordDeletes("node", { [NODE]: 409 }));

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ recently_ready: 1 }),
    );
    await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
      result({ recently_ready: 1 }),
    );

    expect(deletes).toEqual([`node ${NODE}`, `node ${NODE}`]);
    expect(logger.log).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE} registered a new Node, skipping`,
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("flags a forbidden Node delete, still deletes the Jobs of every removed node and keeps their volumes", async () => {
    nodes.push(node(NODE, "Unknown"), node(OTHER_NODE, "False"));
    leftoversOf(NODE);
    leftoversOf(OTHER_NODE);
    deleteNode.mockImplementation(
      recordDeletes("node", { [NODE]: 403, [OTHER_NODE]: 403 }),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ jobs: 4, node_delete_forbidden: true }),
    );

    expect(deletes).toEqual([
      `node ${NODE}`,
      `job update-cs-server-${NODE}`,
      `job update-csgo-server-${NODE}`,
      `node ${OTHER_NODE}`,
      `job update-cs-server-${OTHER_NODE}`,
      `job update-csgo-server-${OTHER_NODE}`,
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE}: not allowed to delete the Node, the api ClusterRole needs the delete verb on nodes. Keeping its volumes; run the cleanup in the server settings once git pull && ./update.sh in the panel has applied that ClusterRole`,
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("counts a failed Node delete, still deletes the Jobs and keeps the volumes for the retry", async () => {
    nodes.push(node(NODE, "Unknown"));
    leftoversOf(NODE);
    deleteNode.mockImplementation(recordDeletes("node", { [NODE]: 500 }));

    await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
      result({ jobs: 2, failed: 1 }),
    );

    expect(deletes).toEqual([
      `node ${NODE}`,
      `job update-cs-server-${NODE}`,
      `job update-csgo-server-${NODE}`,
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      `[node-cleanup] ${NODE}: unable to delete the Node`,
      "HTTP-Code: 500",
    );
  });

  it("counts any other error as failed and keeps a volume whose claim could not be deleted", async () => {
    nodes.push(node(NODE, "Unknown"));
    jobs.push(updateJob(NODE), updateJob(NODE, "csgo"));
    volumes.push(
      volume(`demos-${NODE}`, NODE),
      volume(`steamcmd-${NODE}`, NODE),
    );
    claims.push(claim(`demos-${NODE}-claim`), claim(`steamcmd-${NODE}-claim`));
    deleteNamespacedJob.mockImplementation(
      recordDeletes("job", { [`update-cs-server-${NODE}`]: 500 }),
    );
    deleteNamespacedPersistentVolumeClaim.mockImplementation(
      recordDeletes("claim", { [`demos-${NODE}-claim`]: 500 }),
    );
    deletePersistentVolume.mockImplementation(
      recordDeletes("volume", { [`steamcmd-${NODE}`]: 500 }),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ nodes: 1, jobs: 1, volume_claims: 1, failed: 3 }),
    );

    expect(deletes).toEqual([
      `node ${NODE}`,
      `job update-cs-server-${NODE}`,
      `job update-csgo-server-${NODE}`,
      `claim demos-${NODE}-claim`,
      `claim steamcmd-${NODE}-claim`,
      `volume steamcmd-${NODE}`,
    ]);
    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it("logs how many removed node ids a sweep cleaned without failures, skips or a forbidden Node delete", async () => {
    const FAILING_NODE = "c9d0e1f2";
    const FORBIDDEN_NODE = "d7e8f9a0";
    const LIVE_NODE = "f3a4b5c6";
    nodes.push(
      node(NODE, "Unknown"),
      node(FAILING_NODE, "Unknown"),
      node(FORBIDDEN_NODE, "Unknown"),
      node(OTHER_NODE, "True"),
      node(LIVE_NODE, "True"),
    );
    rows.push(LIVE_NODE);
    leftoversOf(NODE);
    leftoversOf(FAILING_NODE);
    leftoversOf(FORBIDDEN_NODE);
    deleteNamespacedJob.mockImplementation(
      recordDeletes("job", { [`update-cs-server-${FAILING_NODE}`]: 500 }),
    );
    deleteNode.mockImplementation(
      recordDeletes("node", { [FORBIDDEN_NODE]: 403 }),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({
        nodes: 2,
        jobs: 5,
        volume_claims: 2,
        volumes: 2,
        failed: 1,
        node_delete_forbidden: true,
        recently_ready: 1,
      }),
    );

    expect(logger.log).toHaveBeenCalledWith(
      `[node-cleanup] ${OTHER_NODE} is still Ready, skipping`,
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[node-cleanup] sweep cleaned 1 of 4 removed node id(s): deleted 5 job(s), 2 volume claim(s), 2 volume(s) and 2 node(s), 1 failed, node delete forbidden, 1 recently Ready",
    );
  });

  it("cleans only the given node when called for one removed node", async () => {
    nodes.push(node(NODE, "Unknown"), node(OTHER_NODE, "Unknown"));
    leftoversOf(NODE);
    leftoversOf(OTHER_NODE);

    await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
      result({ nodes: 1, jobs: 2, volume_claims: 1, volumes: 1 }),
    );

    expect(readNode).toHaveBeenCalledWith({ name: NODE });
    expect(listNode).not.toHaveBeenCalled();
    expect(hasura.query).toHaveBeenCalledWith({
      game_server_nodes: {
        __args: { where: { id: { _in: [NODE] } } },
        id: true,
      },
    });
    expect(deletes).toEqual([`node ${NODE}`, ...deletesOfLeftovers(NODE)]);
  });

  it("still cleans one removed node whose k8s Node is already gone", async () => {
    leftoversOf(NODE);

    await expect(service.cleanupRemovedNodes(NODE)).resolves.toEqual(
      result({ jobs: 2, volume_claims: 1, volumes: 1 }),
    );

    expect(deletes).toEqual(deletesOfLeftovers(NODE));
    expect(deleteNode).not.toHaveBeenCalled();
  });

  it("does not delete terminating objects again, but still deletes a live claim of a terminating volume", async () => {
    const deletionTimestamp = new Date("2026-09-30T12:00:00Z");
    nodes.push(node(NODE, "Unknown", { deletionTimestamp }));
    jobs.push(
      job(
        `update-cs-server-${NODE}`,
        { app: "update-cs-server" },
        { affinity: hostnamePin([NODE]) },
        { deletionTimestamp },
      ),
      updateJob(NODE, "csgo"),
    );
    volumes.push(
      volume(`demos-${NODE}`, NODE, {}, { deletionTimestamp }),
      volume(`steamcmd-${NODE}`, NODE),
    );
    claims.push(
      claim(`demos-${NODE}-claim`),
      claim(`steamcmd-${NODE}-claim`, `steamcmd-${NODE}`, {
        deletionTimestamp,
      }),
    );

    await expect(service.cleanupRemovedNodes()).resolves.toEqual(
      result({ jobs: 1, volume_claims: 1, volumes: 1 }),
    );

    expect(deletes).toEqual([
      `job update-csgo-server-${NODE}`,
      `claim demos-${NODE}-claim`,
      `volume steamcmd-${NODE}`,
    ]);
  });

  const listFailures: Array<[string, () => void, string | undefined]> = [
    ["Nodes", () => listNode.mockRejectedValue(apiError(500)), undefined],
    [
      "Jobs",
      () => listNamespacedJob.mockRejectedValue(apiError(500)),
      undefined,
    ],
    [
      "volumes",
      () => listPersistentVolume.mockRejectedValue(apiError(500)),
      undefined,
    ],
    [
      "volume claims",
      () =>
        listNamespacedPersistentVolumeClaim.mockRejectedValue(apiError(500)),
      undefined,
    ],
    [
      "removed node's Node",
      () => readNode.mockRejectedValue(apiError(500)),
      NODE,
    ],
  ];

  it.each(listFailures)(
    "fails without deleting anything when reading the %s fails",
    async (_what, fail, onlyNodeId) => {
      nodes.push(node(NODE, "Unknown"));
      leftoversOf(NODE);
      fail();

      await expect(service.cleanupRemovedNodes(onlyNodeId)).rejects.toThrow(
        "unable to list cluster objects",
      );

      expect(deletes).toEqual([]);
      expect(hasura.query).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        "[node-cleanup] unable to list cluster objects",
        "HTTP-Code: 500",
      );
    },
  );

  it("fails without deleting anything when the game server node rows cannot be read", async () => {
    nodes.push(node(NODE, "Unknown"));
    leftoversOf(NODE);
    hasura.query.mockRejectedValue("database is unavailable");

    await expect(service.cleanupRemovedNodes()).rejects.toThrow(
      "unable to read game server nodes",
    );
    await expect(service.cleanupRemovedNodes(NODE)).rejects.toThrow(
      "unable to read game server nodes",
    );

    expect(deletes).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "[node-cleanup] unable to read game server nodes",
      "database is unavailable",
    );
  });
});
