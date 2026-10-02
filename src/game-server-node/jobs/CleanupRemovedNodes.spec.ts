const mockCore = {
  listNode: jest.fn(),
  deleteNode: jest.fn(),
  listPersistentVolume: jest.fn(),
  deletePersistentVolume: jest.fn(),
  readNamespacedPersistentVolumeClaim: jest.fn(),
  deleteNamespacedPersistentVolumeClaim: jest.fn(),
};
const mockBatch = {
  listNamespacedJob: jest.fn(),
  deleteNamespacedJob: jest.fn(),
};

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(api: { name: string }) {
      return api.name === "BatchV1Api" ? mockBatch : mockCore;
    }
  },
}));

import { CleanupRemovedNodes } from "./CleanupRemovedNodes";

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

const node = (
  name: string,
  {
    ready = "False",
    since = minutesAgo(30),
    labels = {},
  }: { ready?: string; since?: string; labels?: Record<string, string> } = {},
) => ({
  metadata: {
    name,
    uid: `uid-${name}`,
    labels: { "5stack-id": name, ...labels },
    creationTimestamp: minutesAgo(60),
  },
  status: {
    conditions: [{ type: "Ready", status: ready, lastTransitionTime: since }],
  },
});

const job = (name: string, app: string, host: string) => ({
  metadata: { name, uid: `uid-${name}` },
  spec: {
    template: {
      metadata: { labels: { app } },
      spec: {
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [
                    {
                      key: "kubernetes.io/hostname",
                      operator: "In",
                      values: [host],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  },
});

const volume = (name: string, id: string, spec: Record<string, any> = {}) => ({
  metadata: { name, uid: `uid-${name}` },
  spec: {
    storageClassName: "local-storage",
    persistentVolumeReclaimPolicy: "Retain",
    claimRef: { namespace: "5stack", name: `${name}-claim` },
    nodeAffinity: {
      required: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: "5stack-id", operator: "In", values: [id] },
            ],
          },
        ],
      },
    },
    ...spec,
  },
});

describe("CleanupRemovedNodes", () => {
  let logger: { log: jest.Mock; warn: jest.Mock };
  let cleanup: CleanupRemovedNodes;

  const setup = ({
    rows = [] as string[],
    nodes = [] as unknown[],
    jobs = [] as unknown[],
    volumes = [] as unknown[],
  }) => {
    mockCore.listNode.mockResolvedValue({ items: nodes });
    mockBatch.listNamespacedJob.mockResolvedValue({ items: jobs });
    mockCore.listPersistentVolume.mockResolvedValue({ items: volumes });
    mockCore.readNamespacedPersistentVolumeClaim.mockImplementation(
      async ({ name }: { name: string }) => ({
        metadata: { uid: `uid-${name}` },
        spec: { volumeName: name.replace(/-claim$/, "") },
      }),
    );

    logger = { log: jest.fn(), warn: jest.fn() };
    cleanup = new CleanupRemovedNodes(
      {
        query: jest.fn().mockResolvedValue({
          game_server_nodes: rows.map((id) => ({ id })),
        }),
      } as any,
      { get: () => ({ namespace: "5stack" }) } as any,
      logger as any,
    );
  };

  const deleted = (mock: jest.Mock) =>
    mock.mock.calls.map(([{ name }]) => name);

  beforeEach(() => {
    jest.clearAllMocks();
    for (const mock of [
      mockCore.deleteNode,
      mockCore.deletePersistentVolume,
      mockCore.deleteNamespacedPersistentVolumeClaim,
      mockBatch.deleteNamespacedJob,
    ]) {
      mock.mockResolvedValue({});
    }
  });

  it("deletes only the Nodes of removed nodes that stayed NotReady", async () => {
    setup({
      rows: ["has-row"],
      nodes: [
        node("removed"),
        node("has-row"),
        node("still-ready", { ready: "True" }),
        node("just-went-down", { since: minutesAgo(2) }),
        node("panel", {
          labels: { "node-role.kubernetes.io/control-plane": "true" },
        }),
      ],
    });

    await cleanup.process();

    expect(deleted(mockCore.deleteNode)).toEqual(["removed"]);
    expect(mockCore.deleteNode).toHaveBeenCalledWith({
      name: "removed",
      body: { preconditions: { uid: "uid-removed" } },
    });
  });

  it("deletes the jobs, claims and volumes of a node with no row and no Node", async () => {
    setup({
      rows: ["has-row"],
      nodes: [node("still-registered", { ready: "True" })],
      jobs: [
        job("update-cs-server-gone", "update-cs-server", "gone"),
        job("streamer-gone", "game-streamer", "gone"),
        job("match-gone", "game-server", "gone"),
        job("update-cs-server-has-row", "update-cs-server", "has-row"),
        job(
          "update-cs-server-registered",
          "update-cs-server",
          "still-registered",
        ),
      ],
      volumes: [
        volume("serverfiles-gone", "gone"),
        volume("demos-gone", "gone", {
          persistentVolumeReclaimPolicy: "Delete",
        }),
        volume("steamcmd-gone", "gone", {
          claimRef: { namespace: "other", name: "steamcmd-gone-claim" },
        }),
        volume("serverfiles-has-row", "has-row"),
        volume("serverfiles-still-registered", "still-registered"),
      ],
    });

    await cleanup.process();

    expect(deleted(mockBatch.deleteNamespacedJob)).toEqual([
      "update-cs-server-gone",
      "streamer-gone",
    ]);
    expect(mockBatch.deleteNamespacedJob).toHaveBeenCalledWith({
      name: "update-cs-server-gone",
      namespace: "5stack",
      body: {
        propagationPolicy: "Background",
        preconditions: { uid: "uid-update-cs-server-gone" },
      },
    });
    expect(deleted(mockCore.deleteNamespacedPersistentVolumeClaim)).toEqual([
      "serverfiles-gone-claim",
    ]);
    expect(deleted(mockCore.deletePersistentVolume)).toEqual([
      "serverfiles-gone",
    ]);
  });

  it("keeps a volume's claim when it is bound to another volume", async () => {
    setup({
      volumes: [volume("serverfiles-gone", "gone", { claimRef: undefined })],
    });
    mockCore.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { uid: "uid-claim" },
      spec: { volumeName: "something-else" },
    });

    await cleanup.process();

    expect(
      mockCore.deleteNamespacedPersistentVolumeClaim,
    ).not.toHaveBeenCalled();
    expect(deleted(mockCore.deletePersistentVolume)).toEqual([
      "serverfiles-gone",
    ]);
  });

  it("ignores objects that are already gone and explains a forbidden Node delete", async () => {
    setup({
      nodes: [node("removed")],
      volumes: [volume("serverfiles-gone", "gone")],
    });
    mockCore.deleteNode.mockRejectedValue({ code: 403 });
    mockCore.deletePersistentVolume.mockRejectedValue({ code: 404 });

    await cleanup.process();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("run ./update.sh");
  });
});
