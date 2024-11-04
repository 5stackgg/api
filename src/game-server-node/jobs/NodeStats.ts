import { SingleNodeMetrics } from "@kubernetes/client-node";

export class NodeStats {
  memoryAllocatable: string;
  memoryCapacity: string;
  cpuCapacity: number;
  cpuWindow: number;
  metrics: SingleNodeMetrics;
}
