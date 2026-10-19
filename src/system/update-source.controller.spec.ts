import { SystemController } from "./system.controller";

describe("admin update-source API", () => {
  const service = {
    getUpdateSourceStatus: jest
      .fn()
      .mockResolvedValue({ source: { version: 1, mode: "installed" } }),
    saveUpdateSource: jest.fn().mockResolvedValue({ applied: false }),
  };
  const controller = () =>
    new SystemController(
      service as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  beforeEach(() => jest.clearAllMocks());
  it.each([undefined, { role: "user" }, { role: "moderator" }])(
    "rejects reads and writes for %p",
    async (user) => {
      await expect(
        controller().updateSourceStatus({ user } as any),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        controller().saveUpdateSource({ user } as any, {
          source: {},
          resourceVersion: "1",
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(service.saveUpdateSource).not.toHaveBeenCalled();
    },
  );
  it("allows an admin to save an explicitly reviewed profile version", async () => {
    const body = {
      source: { version: 1, mode: "official", channel: "beta" },
      resourceVersion: "7",
    };
    await controller().saveUpdateSource(
      { user: { role: "administrator" } } as any,
      body,
    );
    expect(service.saveUpdateSource).toHaveBeenCalledWith(body.source, "7");
  });
});
