import {
  buildSyntheticMatchServerLogEntries,
  deriveMatchServerBootDiagnostic,
} from "./bootDiagnostics";

describe("bootDiagnostics", () => {
  it("maps FailedScheduling to a terminal failed state", () => {
    const diagnostic = deriveMatchServerBootDiagnostic({
      podPhase: "Pending",
      events: [
        {
          type: "Warning",
          reason: "FailedScheduling",
          message: "0/2 nodes are available",
          lastTimestamp: "2026-04-23T12:00:00.000Z",
        },
      ],
    });

    expect(diagnostic).toEqual({
      status: "Failed",
      detail: "FailedScheduling: 0/2 nodes are available",
      terminal: true,
    });
  });

  it("maps pulling events to PullingImage", () => {
    const diagnostic = deriveMatchServerBootDiagnostic({
      podPhase: "Pending",
      containerStatuses: [
        {
          state: {
            waiting: {
              reason: "ContainerCreating",
            },
          },
        },
      ],
      events: [
        {
          reason: "Pulling",
          message: 'Pulling image "ghcr.io/5stackgg/game-server:latest"',
          lastTimestamp: "2026-04-23T12:01:00.000Z",
        },
      ],
    });

    expect(diagnostic.status).toBe("PullingImage");
    expect(diagnostic.terminal).toBe(false);
    expect(diagnostic.detail).toContain("Pulling");
  });

  it("maps ContainerCreating without pull events to Booting", () => {
    const diagnostic = deriveMatchServerBootDiagnostic({
      podPhase: "Pending",
      containerStatuses: [
        {
          state: {
            waiting: {
              reason: "ContainerCreating",
            },
          },
        },
      ],
    });

    expect(diagnostic).toEqual({
      status: "Booting",
      detail: "ContainerCreating",
      terminal: false,
    });
  });

  it("maps ImagePullBackOff to a terminal failed state", () => {
    const diagnostic = deriveMatchServerBootDiagnostic({
      podPhase: "Pending",
      containerStatuses: [
        {
          state: {
            waiting: {
              reason: "ImagePullBackOff",
              message: "Back-off pulling image",
            },
          },
        },
      ],
    });

    expect(diagnostic).toEqual({
      status: "Failed",
      detail: "ImagePullBackOff: Back-off pulling image",
      terminal: true,
    });
  });

  it("maps CrashLoopBackOff to a terminal failed state", () => {
    const diagnostic = deriveMatchServerBootDiagnostic({
      podPhase: "Pending",
      containerStatuses: [
        {
          state: {
            waiting: {
              reason: "CrashLoopBackOff",
              message: "Back-off restarting failed container",
            },
          },
        },
      ],
    });

    expect(diagnostic).toEqual({
      status: "Failed",
      detail: "CrashLoopBackOff: Back-off restarting failed container",
      terminal: true,
    });
  });

  it("maps running pods to WaitingForPing", () => {
    const diagnostic = deriveMatchServerBootDiagnostic({
      podPhase: "Running",
      events: [
        {
          reason: "Started",
          message: 'Started container "game-server"',
          lastTimestamp: "2026-04-23T12:02:00.000Z",
        },
      ],
    });

    expect(diagnostic).toEqual({
      status: "WaitingForPing",
      detail: 'Started: Started container "game-server"',
      terminal: false,
    });
  });

  it("builds synthetic event logs from diagnostics when no events exist", () => {
    const logs = buildSyntheticMatchServerLogEntries({
      diagnostic: {
        status: "Creating",
        detail: "Waiting for Kubernetes to create the match server pod.",
        terminal: false,
      },
      podName: "m-test",
      nodeName: "node-1",
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].pod).toBe("m-test");
    expect(logs[0].container).toBe("k8s-events");
    expect(logs[0].log).toBe(
      "Waiting for Kubernetes to create the match server pod.",
    );
  });
});
