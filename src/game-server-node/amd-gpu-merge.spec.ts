import { mergeAmdGpu } from "./amd-gpu-merge";
import { GpuDevice, GpuStats } from "./interfaces/NodeStats";

describe("mergeAmdGpu", () => {
  // nodeStats.gpu of an AMD node: the NVIDIA reader finds nothing there.
  const noNvidia: GpuStats = { count: 0, devices: null };

  const nvidia: GpuDevice = {
    index: 0,
    name: "NVIDIA GeForce RTX 3060",
    memory_mb: 12288,
    memory_used_mb: 1024,
    temperature_c: 41,
    power_w: 35,
    utilization_percent: 2,
  };

  // A discrete card as the connector reports it in nodeStats.amdGpu.
  const discrete: GpuDevice = {
    index: 0,
    name: "AMD Radeon RX 7600",
    memory_mb: 8192,
    memory_used_mb: 310,
    gtt_total_mb: 15872,
    gtt_used_mb: 45,
    utilization_percent: 1,
    temperature_c: 38,
    power_w: 9,
    encoder_utilization_percent: 0,
    pci_bus_id: "0000:03:00.0",
    pci_id: "1002:7480",
    pci_revision: "cf",
    render_node: "renderD129",
    integrated: false,
  };

  // The Strix Halo APU, which also runs the desktop and other GPU work.
  const integrated: GpuDevice = {
    index: 0,
    name: "AMD Radeon 8060S Graphics",
    memory_mb: 512,
    memory_used_mb: 180,
    gtt_total_mb: 65536,
    gtt_used_mb: 2300,
    utilization_percent: 3,
    temperature_c: 46,
    power_w: 28,
    encoder_utilization_percent: 0,
    pci_bus_id: "0000:c5:00.0",
    pci_id: "1002:1586",
    pci_revision: "c1",
    render_node: "renderD128",
    integrated: true,
  };

  it("keeps the gpu as it is with 'nvidia' when there is no amdGpu", () => {
    const gpu: GpuStats = { count: 1, devices: [nvidia] };

    const merged = mergeAmdGpu(gpu, undefined, {});

    expect(merged.gpu).toBe(gpu);
    expect(merged.gpuVendor).toBe("nvidia");
    expect(merged.warnings).toEqual([]);
  });

  it("serves a discrete device as the node's AMD GPU", () => {
    expect(
      mergeAmdGpu(noNvidia, { count: 1, devices: [discrete] }, {}),
    ).toEqual({
      gpu: { count: 1, devices: [discrete] },
      gpuVendor: "amd",
      warnings: [],
    });
  });

  it("drops an integrated device without 5stack-gpu-integrated=true, with a warning naming the label", () => {
    const merged = mergeAmdGpu(
      noNvidia,
      { count: 1, devices: [integrated] },
      { "5stack-gpu-vendor": "amd" },
    );

    expect(merged.gpu).toEqual({ count: 0, devices: null });
    expect(merged.gpuVendor).toBe("nvidia");
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0]).toContain("5stack-gpu-integrated=true");
  });

  it("serves an integrated device when the node carries 5stack-gpu-integrated=true", () => {
    expect(
      mergeAmdGpu(
        noNvidia,
        { count: 1, devices: [integrated] },
        { "5stack-gpu-vendor": "amd", "5stack-gpu-integrated": "true" },
      ),
    ).toEqual({
      gpu: { count: 1, devices: [integrated] },
      gpuVendor: "amd",
      warnings: [],
    });
  });

  it.each([
    ["NVIDIA devices", { count: 1, devices: [nvidia] }],
    ["a legacy nvidiaGPU count", { count: 1, devices: null }],
  ] as Array<[string, GpuStats]>)(
    "keeps a gpu with %s as it is, with 'nvidia' and one warning",
    (_label, gpu) => {
      const merged = mergeAmdGpu(gpu, { count: 1, devices: [discrete] }, {});

      expect(merged.gpu).toBe(gpu);
      expect(merged.gpuVendor).toBe("nvidia");
      expect(merged.warnings).toHaveLength(1);
    },
  );

  it("lowercases an uppercase PCI address and keeps the device", () => {
    const amdGpu: GpuStats = {
      count: 1,
      devices: [{ ...discrete, pci_bus_id: "0000:C5:00.0" }],
    };

    expect(mergeAmdGpu(noNvidia, amdGpu, {})).toEqual({
      gpu: { count: 1, devices: [{ ...discrete, pci_bus_id: "0000:c5:00.0" }] },
      gpuVendor: "amd",
      warnings: [],
    });
    // The ping's own device is left as it came.
    expect(amdGpu.devices[0].pci_bus_id).toBe("0000:C5:00.0");
  });

  it.each([
    ["a PCI address without its domain", { pci_bus_id: "c5:00.0" }],
    ["no PCI address", { pci_bus_id: undefined }],
    ["no render node", { render_node: undefined }],
    ["a render node that is not renderD<n>", { render_node: "card1" }],
  ] as Array<[string, Partial<GpuDevice>]>)(
    "drops a device with %s, so the node reports no GPU",
    (_label, fields) => {
      expect(
        mergeAmdGpu(
          noNvidia,
          { count: 1, devices: [{ ...discrete, ...fields }] },
          {},
        ),
      ).toEqual({
        gpu: { count: 0, devices: null },
        gpuVendor: "nvidia",
        warnings: [expect.any(String)],
      });
    },
  );

  it("serves the lowest PCI address of two devices as index 0, with one warning naming the other", () => {
    const higher: GpuDevice = {
      ...discrete,
      pci_bus_id: "0000:0a:00.0",
      render_node: "renderD130",
    };
    const lower: GpuDevice = { ...discrete, index: 1 };

    const merged = mergeAmdGpu(
      noNvidia,
      { count: 2, devices: [higher, lower] },
      {},
    );

    expect(merged.gpu).toEqual({
      count: 1,
      devices: [{ ...discrete, index: 0 }],
    });
    expect(merged.gpuVendor).toBe("amd");
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0]).toContain("0000:0a:00.0");
  });

  it("reports no GPU, without a warning of its own, when amdGpu carries no device", () => {
    // The connector already logged why it found none.
    expect(mergeAmdGpu(noNvidia, { count: 0, devices: null }, {})).toEqual({
      gpu: { count: 0, devices: null },
      gpuVendor: "nvidia",
      warnings: [],
    });
  });
});
