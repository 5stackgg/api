export type MatchServerBootStatus =
  | "Creating"
  | "PendingScheduling"
  | "PullingImage"
  | "Booting"
  | "WaitingForPing"
  | "Failed";

export interface MatchServerBootEventLike {
  type?: string | null;
  reason?: string | null;
  message?: string | null;
  eventTime?: string | Date | null;
  lastTimestamp?: string | Date | null;
  firstTimestamp?: string | Date | null;
  metadata?: {
    creationTimestamp?: string | Date | null;
  } | null;
}

export interface MatchServerBootConditionLike {
  type?: string | null;
  status?: string | null;
  reason?: string | null;
  message?: string | null;
}

export interface MatchServerBootContainerStatusLike {
  state?: {
    waiting?: {
      reason?: string | null;
      message?: string | null;
    } | null;
    terminated?: {
      reason?: string | null;
      message?: string | null;
    } | null;
  } | null;
}

export interface MatchServerBootDiagnostic {
  status: MatchServerBootStatus;
  detail: string;
  terminal: boolean;
}

export interface MatchServerSyntheticLogEntry {
  kind: "event";
  pod: string;
  node: string;
  container: string;
  timestamp: string;
  reason?: string | null;
  log: string;
}

const TERMINAL_REASONS = new Set([
  "CreateContainerConfigError",
  "CreateContainerError",
  "CrashLoopBackOff",
  "ErrImagePull",
  "Failed",
  "FailedScheduling",
  "ImageInspectError",
  "ImagePullBackOff",
  "InvalidImageName",
  "RunContainerError",
]);

const BOOTING_WAIT_REASONS = new Set(["ContainerCreating", "PodInitializing"]);
const PULLING_REASONS = new Set(["Pulling"]);

function asTimestamp(value?: string | Date | null): number {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toIsoTimestamp(value?: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

export function sortBootEventsNewestFirst<T extends MatchServerBootEventLike>(
  events: T[],
): T[] {
  return [...events].sort((a, b) => {
    const aTime = Math.max(
      asTimestamp(a.lastTimestamp),
      asTimestamp(a.eventTime),
      asTimestamp(a.firstTimestamp),
      asTimestamp(a.metadata?.creationTimestamp),
    );
    const bTime = Math.max(
      asTimestamp(b.lastTimestamp),
      asTimestamp(b.eventTime),
      asTimestamp(b.firstTimestamp),
      asTimestamp(b.metadata?.creationTimestamp),
    );

    return bTime - aTime;
  });
}

export function sortBootEventsOldestFirst<T extends MatchServerBootEventLike>(
  events: T[],
): T[] {
  return sortBootEventsNewestFirst(events).reverse();
}

export function isTerminalMatchServerBootReason(
  reason?: string | null,
): boolean {
  return TERMINAL_REASONS.has(reason || "");
}

export function formatKubernetesReason(
  reason?: string | null,
  message?: string | null,
): string | null {
  const trimmedReason = reason?.trim();
  const trimmedMessage = message?.trim();

  if (trimmedReason && trimmedMessage) {
    return `${trimmedReason}: ${trimmedMessage}`;
  }

  return trimmedReason || trimmedMessage || null;
}

export function deriveMatchServerBootDiagnostic(input: {
  jobFailed?: boolean;
  jobFailureReason?: string | null;
  jobFailureMessage?: string | null;
  podPhase?: string | null;
  podConditions?: MatchServerBootConditionLike[] | null;
  containerStatuses?: MatchServerBootContainerStatusLike[] | null;
  initContainerStatuses?: MatchServerBootContainerStatusLike[] | null;
  events?: MatchServerBootEventLike[] | null;
}): MatchServerBootDiagnostic {
  const events = sortBootEventsNewestFirst(input.events || []);

  if (input.jobFailed) {
    return {
      status: "Failed",
      detail:
        formatKubernetesReason(
          input.jobFailureReason,
          input.jobFailureMessage,
        ) || "Match server job failed to start.",
      terminal: true,
    };
  }

  const latestTerminalEvent = events.find((event) =>
    isTerminalMatchServerBootReason(event.reason),
  );
  if (latestTerminalEvent) {
    return {
      status: "Failed",
      detail:
        formatKubernetesReason(
          latestTerminalEvent.reason,
          latestTerminalEvent.message,
        ) || "Match server failed to start.",
      terminal: true,
    };
  }

  const scheduledCondition = (input.podConditions || []).find(
    (condition) => condition.type === "PodScheduled",
  );
  if (scheduledCondition?.status === "False") {
    const detail =
      formatKubernetesReason(
        scheduledCondition.reason,
        scheduledCondition.message,
      ) || "Waiting for Kubernetes to schedule the match server pod.";

    return isTerminalMatchServerBootReason(scheduledCondition.reason)
      ? { status: "Failed", detail, terminal: true }
      : { status: "PendingScheduling", detail, terminal: false };
  }

  const containerStatuses = [
    ...(input.initContainerStatuses || []),
    ...(input.containerStatuses || []),
  ];

  const terminated = containerStatuses.find((status) =>
    isTerminalMatchServerBootReason(status.state?.terminated?.reason),
  )?.state?.terminated;
  if (terminated) {
    return {
      status: "Failed",
      detail:
        formatKubernetesReason(terminated.reason, terminated.message) ||
        "Match server container terminated during startup.",
      terminal: true,
    };
  }

  const waiting = containerStatuses.find((status) => status.state?.waiting)
    ?.state?.waiting;

  if (waiting?.reason) {
    if (isTerminalMatchServerBootReason(waiting.reason)) {
      return {
        status: "Failed",
        detail:
          formatKubernetesReason(waiting.reason, waiting.message) ||
          "Match server container failed while starting.",
        terminal: true,
      };
    }

    if (PULLING_REASONS.has(waiting.reason)) {
      return {
        status: "PullingImage",
        detail:
          formatKubernetesReason(waiting.reason, waiting.message) ||
          "Pulling the match server image.",
        terminal: false,
      };
    }

    if (BOOTING_WAIT_REASONS.has(waiting.reason)) {
      const latestPullEvent = events.find((event) =>
        PULLING_REASONS.has(event.reason || ""),
      );

      if (latestPullEvent) {
        return {
          status: "PullingImage",
          detail:
            formatKubernetesReason(
              latestPullEvent.reason,
              latestPullEvent.message,
            ) || "Pulling the match server image.",
          terminal: false,
        };
      }

      return {
        status: "Booting",
        detail:
          formatKubernetesReason(waiting.reason, waiting.message) ||
          "Match server pod is starting.",
        terminal: false,
      };
    }
  }

  const latestPullEvent = events.find((event) =>
    PULLING_REASONS.has(event.reason || ""),
  );
  if (latestPullEvent) {
    return {
      status: "PullingImage",
      detail:
        formatKubernetesReason(
          latestPullEvent.reason,
          latestPullEvent.message,
        ) || "Pulling the match server image.",
      terminal: false,
    };
  }

  if (input.podPhase === "Running") {
    const latestStartedEvent = events.find((event) =>
      ["Pulled", "Created", "Started"].includes(event.reason || ""),
    );

    return {
      status: "WaitingForPing",
      detail:
        formatKubernetesReason(
          latestStartedEvent?.reason,
          latestStartedEvent?.message,
        ) || "Server pod is running. Waiting for the first server ping.",
      terminal: false,
    };
  }

  if (input.podPhase === "Succeeded" || input.podPhase === "Failed") {
    const latestEvent = events.at(0);

    return {
      status: "Failed",
      detail:
        formatKubernetesReason(latestEvent?.reason, latestEvent?.message) ||
        `Match server pod exited with phase ${input.podPhase}.`,
      terminal: true,
    };
  }

  if (input.podPhase === "Pending") {
    return {
      status: "Booting",
      detail:
        formatKubernetesReason(events.at(0)?.reason, events.at(0)?.message) ||
        "Match server pod is starting.",
      terminal: false,
    };
  }

  return {
    status: "Creating",
    detail: "Waiting for Kubernetes to create the match server pod.",
    terminal: false,
  };
}

export function buildSyntheticMatchServerLogEntries(input: {
  diagnostic: MatchServerBootDiagnostic;
  events?: MatchServerBootEventLike[] | null;
  podName?: string | null;
  nodeName?: string | null;
  container?: string;
}): MatchServerSyntheticLogEntry[] {
  const events = sortBootEventsOldestFirst(input.events || []);
  const podName = input.podName || "pending-pod";
  const nodeName = input.nodeName || "pending-node";
  const container = input.container || "k8s-events";
  const seen = new Set<string>();
  const entries: MatchServerSyntheticLogEntry[] = [];

  for (const event of events) {
    const timestamp =
      toIsoTimestamp(event.lastTimestamp) ||
      toIsoTimestamp(event.eventTime) ||
      toIsoTimestamp(event.firstTimestamp) ||
      toIsoTimestamp(event.metadata?.creationTimestamp) ||
      new Date().toISOString();
    const log = formatKubernetesReason(event.reason, event.message);

    if (!log) {
      continue;
    }

    const key = `${timestamp}:${log}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    entries.push({
      kind: "event",
      pod: podName,
      node: nodeName,
      container,
      timestamp,
      reason: event.reason || null,
      log,
    });
  }

  if (entries.length > 0) {
    return entries;
  }

  return [
    {
      kind: "event",
      pod: podName,
      node: nodeName,
      container,
      timestamp: new Date().toISOString(),
      reason: input.diagnostic.status,
      log: input.diagnostic.detail,
    },
  ];
}
