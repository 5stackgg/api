import { SingleNodeMetrics } from "@kubernetes/client-node"

export class NodeStats {
  memoryAllocatable: string;
  memoryCapacity: string;
  cpuAllocatable: string;
  cpuCapacity: string;
  metrics: SingleNodeMetrics
}