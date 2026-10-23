import { PluginsController } from "./plugins.controller";

function detect(manifest: Record<string, unknown>) {
  jest
    .spyOn(global, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(manifest)));

  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  return new PluginsController()
    .detect(
      {
        user: { role: "administrator" },
        query: { url: "https://inventory.example.com" },
      } as any,
      res as any,
    )
    .then(() => res);
}

describe("PluginsController detect", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the profile tab label and featured flag through", async () => {
    const res = await detect({
      name: "Inventory",
      slug: "inventory",
      remoteEntry: "/assets/remoteEntry.js",
      profileTabLabel: "Inventory",
      featured: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      remoteEntry: "https://inventory.example.com/assets/remoteEntry.js",
      profileTabLabel: "Inventory",
      featured: true,
    });
  });

  it("leaves a plugin unfeatured unless its manifest says true", async () => {
    for (const featured of [undefined, false, "true", 1]) {
      const res = await detect({ name: "Hello", slug: "hello", featured });

      expect(res.body.featured).toBe(false);
      expect(res.body.profileTabLabel).toBeNull();
    }
  });

  it("drops a profile tab label that isn't text", async () => {
    for (const profileTabLabel of [42, { en: "Inventory" }, "   "]) {
      const res = await detect({
        name: "Hello",
        slug: "hello",
        profileTabLabel,
      });

      expect(res.body.profileTabLabel).toBeNull();
    }
  });
});
