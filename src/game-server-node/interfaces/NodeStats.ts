import { NodeMetric } from "@kubernetes/client-node";
import { NodeDisk } from "./NodeDisk";
import { NetworkStat } from "./NetworkStat";

export interface GpuDevice {
  index: number;
  name: string;
  memory_mb?: number;
  memory_used_mb?: number;
  temperature_c?: number;
  power_w?: number;
  utilization_percent?: number;
}

export interface GpuStats {
  count: number;
  devices: Array<GpuDevice> | null;
}

export class NodeStats {
  gpu: GpuStats;
  cpuInfo: {
    sockets: number;
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
