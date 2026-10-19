import type { CoreV1Event, V1Job, V1Pod } from "@kubernetes/client-node";
import {
  formatKubernetesReason,
  isTerminalMatchServerBootReason,
  sortBootEventsNewestFirst,
} from "../../k8s/logging/bootDiagnostics";

// An unfinished AMD Job older than this is checked on every sweep.
export const AMD_BOOT_WATCHDOG_SECONDS = 180;

// Only Jobs built for an AMD node carry the vendor label.
export const AMD_GPU_JOB_SELECTOR = "app=game-streamer,5stack-gpu-vendor=amd";

// The scheduler's message while another spec pod holds the node's port 1350.
export const FREE_PORTS_WAIT_SUBSTRING = "didn't have free ports";

export type GpuJobBootVerdict = "ignore" | "wait" | "unstartable";

export function isGpuJobFinished(job: V1Job): boolean {
  return (job.status?.succeeded ?? 0) > 0 || (job.status?.failed ?? 0) > 0;
}

// A Job without a readable creation time counts as young, so missing data
// never ends a Job.
export function isGpuJobYoung(job: V1Job, now: number): boolean {
  const created = new Date(job.metadata?.creationTimestamp ?? now).getTime();
  return (
    Number.isNaN(created) || now - created < AMD_BOOT_WATCHDOG_SECONDS * 1000
  );
}

export function classifyGpuJobBoot({
  job,
  pod,
  events,
  now,
}: {
  job: V1Job;
  pod: V1Pod | null;
  events: CoreV1Event[];
  now: number;
}): GpuJobBootVerdict {
  if (isGpuJobFinished(job)) {
    return "ignore";
  }
  if (isGpuJobYoung(job, now)) {
    return "wait";
  }
  if (!pod) {
    return "unstartable";
  }
  if (pod.metadata?.deletionTimestamp) {
    return "wait";
  }
  if (["Running", "Succeeded", "Failed"].includes(pod.status?.phase)) {
    return "ignore";
  }

  // Not the derived terminal flag: FailedScheduling counts as terminal there,
  // which would end a pod that only waits for the spec port.
  const scheduled = pod.status?.conditions?.find(
    (condition) => condition.type === "PodScheduled",
  );
  if (scheduled?.status === "False") {
    return scheduled.message?.includes(FREE_PORTS_WAIT_SUBSTRING)
      ? "wait"
      : "unstartable";
  }

  const containers = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  if (
    containers.some((status) =>
      isTerminalMatchServerBootReason(status.state?.waiting?.reason),
    )
  ) {
    return "unstartable";
  }

  const [newestPodEvent] = sortBootEventsNewestFirst(
    events.filter((event) => event.involvedObject?.kind === "Pod"),
  );
  if (newestPodEvent?.reason === "FailedCreatePodSandBox") {
    return "unstartable";
  }

  // ContainerCreating, Pulling or PodInitializing: the first image pull on a
  // node can take longer than the window.
  return "wait";
}

// Every game-streamer Job is pinned to its node by a required hostname
// affinity, so the node is known before the pod is scheduled.
export function gpuJobNodeName(job: V1Job): string {
  const affinity = job.spec?.template?.spec?.affinity?.nodeAffinity;
  const terms =
    affinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  const hostname = terms?.[0]?.matchExpressions?.find(
    (expression) => expression.key === "kubernetes.io/hostname",
  );
  return hostname?.values?.[0] ?? "unknown";
}

// The newest event of the Job or its pod as "reason: message", else the boot
// diagnostic detail.
export function gpuJobBootReason(
  events: CoreV1Event[],
  detail: string,
): string {
  const [newest] = sortBootEventsNewestFirst(events);
  return formatKubernetesReason(newest?.reason, newest?.message) ?? detail;
}
