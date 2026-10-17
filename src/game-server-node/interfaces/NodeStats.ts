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
  // The AMD reader's extra fields (nodeStats.amdGpu); an NVIDIA device never
  // carries them.
  pci_bus_id?: string;
  pci_id?: string;
  pci_revision?: string;
  render_node?: string;
  integrated?: boolean;
  gtt_total_mb?: number;
  gtt_used_mb?: number;
  encoder_utilization_percent?: number;
}

export interface GpuStats {
  count: number;
  devices: Array<GpuDevice> | null;
}

export class NodeStats {
  gpu: GpuStats;
  // Sent only for a node labelled 5stack-gpu-vendor=amd without
  // nvidia-gpu=true; the ping handler merges it into gpu.
  amdGpu?: GpuStats;
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
