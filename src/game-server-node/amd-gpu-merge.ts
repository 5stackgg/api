import { GpuDevice, GpuStats } from "./interfaces/NodeStats";

// The values the game streamer pod is pinned to: a lowercase PCI address
// (domain:bus:device.function) and a DRM render node name.
const PCI_ADDRESS = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}[.][0-7]$/;
const RENDER_NODE = /^renderD[0-9]+$/;

// The connector sends nodeStats.amdGpu only for a node labelled
// 5stack-gpu-vendor=amd, and it already picks one device. The rules run again
// here so that a connector build that gets them wrong cannot make a node
// claimable: for an AMD node gpu=true has to mean exactly one GPU with a valid
// PCI address and render node, and an integrated GPU (an APU that also runs
// the host's own work) only when the operator labelled the node
// 5stack-gpu-integrated=true. Every warning names a device by its PCI address
// or name only, so a node repeats the same text on every ping and the caller
// can log each one once.
export function mergeAmdGpu(
  gpu: GpuStats,
  amdGpu: GpuStats | undefined,
  labels?: Record<string, string>,
): { gpu: GpuStats; gpuVendor: "nvidia" | "amd"; warnings: Array<string> } {
  const warnings: Array<string> = [];

  if (!amdGpu) {
    return { gpu, gpuVendor: "nvidia", warnings };
  }

  // NVIDIA wins, so a node that is also labelled nvidia-gpu keeps working.
  if ((gpu?.count ?? 0) > 0 || (gpu?.devices?.length ?? 0) > 0) {
    warnings.push(
      "the node reports NVIDIA GPUs and an AMD GPU, so the AMD GPU is ignored",
    );
    return { gpu, gpuVendor: "nvidia", warnings };
  }

  const integratedAllowed = labels?.["5stack-gpu-integrated"] === "true";
  const usable: Array<GpuDevice & { pci_bus_id: string }> = [];
  for (const device of Array.isArray(amdGpu.devices) ? amdGpu.devices : []) {
    if (device.integrated === true && !integratedAllowed) {
      warnings.push(
        `ignoring the integrated AMD GPU ${JSON.stringify(device.pci_bus_id)} (${JSON.stringify(device.name)}): label the node 5stack-gpu-integrated=true to use it`,
      );
      continue;
    }

    const pciBusId =
      typeof device.pci_bus_id === "string"
        ? device.pci_bus_id.toLowerCase()
        : undefined;
    if (pciBusId === undefined || !PCI_ADDRESS.test(pciBusId)) {
      warnings.push(
        `ignoring the AMD GPU ${JSON.stringify(device.name)}: invalid PCI address ${JSON.stringify(device.pci_bus_id)}`,
      );
      continue;
    }

    if (
      typeof device.render_node !== "string" ||
      !RENDER_NODE.test(device.render_node)
    ) {
      warnings.push(
        `ignoring the AMD GPU ${pciBusId}: invalid render node ${JSON.stringify(device.render_node)}`,
      );
      continue;
    }

    usable.push({ ...device, pci_bus_id: pciBusId });
  }

  if (usable.length === 0) {
    return { gpu: { count: 0, devices: null }, gpuVendor: "nvidia", warnings };
  }

  // The GPU claims hand out a node, not a device, so a node serves one GPU:
  // the lowest PCI address, as the connector picks it.
  usable.sort((a, b) =>
    a.pci_bus_id < b.pci_bus_id ? -1 : a.pci_bus_id > b.pci_bus_id ? 1 : 0,
  );
  const [served, ...others] = usable;
  if (others.length > 0) {
    warnings.push(
      `several AMD GPUs reported, using ${served.pci_bus_id} and ignoring ${others.map((device) => device.pci_bus_id).join(", ")}`,
    );
  }

  return {
    gpu: { count: 1, devices: [{ ...served, index: 0 }] },
    gpuVendor: "amd",
    warnings,
  };
}
