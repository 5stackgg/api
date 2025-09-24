import { NodeMetric } from "@kubernetes/client-node";
import { NodeDisk } from "./NodeDisk";
import { NetworkStat } from "./NetworkStat";

export class NodeStats {
  nvidiaGPU: boolean;
  cpuInfo: {
    coresPerSocket: number;
    threadsPerCore: number;
  };
  memoryAllocatable: string;
  memoryCapacity: string;
  cpuCapacity: number;
  cpuWindow: number;
  metrics: NodeMetric;
  disks: Array<NodeDisk>;
  network: NetworkStat;
}
