import AdmZip from "adm-zip";
import { crc32 } from "zlib";
import { BroadcastHudsService } from "./broadcast-huds.service";

// The panel is the only thing that ever uploads to JTs Hud Manager's
// upload-zip, and that endpoint extracts with no traversal guard and takes the
// hud id straight out of the archive. So these are the tests for the only place
// a hostile bundle can be stopped.
describe("BroadcastHudsService.import", () => {
  const zipOf = (
    files: Array<[string, string | Buffer]>,
  ): Buffer => {
    const zip = new AdmZip();
    for (const [name, content] of files) {
      zip.addFile(
        name,
        Buffer.isBuffer(content) ? content : Buffer.from(content),
      );
    }
    return zip.toBuffer();
  };

  // AdmZip's *writer* sanitises entry names -- it strips leading slashes and
  // resolves away `..` -- so a hostile archive cannot be built with it, and a
  // test that tried would silently assert nothing. Real zips have no such
  // manners, so these are emitted byte by byte: stored (uncompressed) entries
  // with whatever name we say.
  const rawZipOf = (files: Array<[string, string]>): Buffer => {
    const locals: Array<Buffer> = [];
    const centrals: Array<Buffer> = [];
    let offset = 0;

    for (const [name, content] of files) {
      const nameBuf = Buffer.from(name, "utf8");
      const data = Buffer.from(content, "utf8");
      const crc = crc32(data);

      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0); // local file header signature
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags
      local.writeUInt16LE(0, 8); // method: stored
      local.writeUInt16LE(0, 10); // mod time
      local.writeUInt16LE(0, 12); // mod date
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18); // compressed size
      local.writeUInt32LE(data.length, 22); // uncompressed size
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // extra length
      nameBuf.copy(local, 30);
      locals.push(local, data);

      const central = Buffer.alloc(46 + nameBuf.length);
      central.writeUInt32LE(0x02014b50, 0); // central directory signature
      central.writeUInt16LE(20, 4); // version made by
      central.writeUInt16LE(20, 6); // version needed
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(0, 12);
      central.writeUInt16LE(0, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30); // extra
      central.writeUInt16LE(0, 32); // comment
      central.writeUInt16LE(0, 34); // disk number
      central.writeUInt16LE(0, 36); // internal attrs
      central.writeUInt32LE(0, 38); // external attrs
      central.writeUInt32LE(offset, 42); // local header offset
      nameBuf.copy(central, 46);
      centrals.push(central);

      offset += local.length + data.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralBuf, end]);
  };

  const manifest = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: "Test Hud", author: "Someone", version: "1.2.3", ...extra });

  let postgres: { query: jest.Mock };
  let s3: { put: jest.Mock; remove: jest.Mock; get: jest.Mock };
  let logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock };
  let service: BroadcastHudsService;
  let inserted: Array<unknown> | null;

  beforeEach(() => {
    inserted = null;
    postgres = {
      query: jest.fn(async (sql: string, params: Array<unknown>) => {
        if (sql.includes("INSERT INTO public.broadcast_huds")) {
          inserted = params;
          return [{ slug: params[0], jthud_id: params[1] }];
        }
        // No existing rows -- every slug is free unless a test says otherwise.
        return [];
      }),
    };
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
    };
    logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    service = new BroadcastHudsService(
      logger as never,
      postgres as never,
      s3 as never,
    );
  });

  const paramsByName = () => {
    const [
      slug,
      jthudId,
      name,
      author,
      version,
      description,
      storageKey,
      sizeBytes,
      thumbnail,
      hudJson,
      isSigned,
    ] = inserted as Array<never>;
    return {
      slug,
      jthudId,
      name,
      author,
      version,
      description,
      storageKey,
      sizeBytes,
      thumbnail,
      hudJson,
      isSigned,
    };
  };

  it("accepts hud.json at the root and takes the hud id from the filename", async () => {
    await service.import(
      zipOf([
        ["hud.json", manifest()],
        ["index.html", "<html></html>"],
      ]),
      "My Cool HUD.zip",
    );

    const p = paramsByName();
    // Mirrors JTHud's own sanitise: non-alphanumerics to dashes, lowercased.
    expect(p.jthudId).toBe("my-cool-hud");
    expect(p.slug).toBe("test-hud");
    expect(p.name).toBe("Test Hud");
    expect(p.author).toBe("Someone");
    expect(p.version).toBe("1.2.3");
    expect(p.isSigned).toBe(false);
    expect(s3.put).toHaveBeenCalledWith(
      "broadcast-huds/test-hud.zip",
      expect.any(Buffer),
      "application/zip",
    );
  });

  it("takes the hud id from the folder when hud.json is one level deep", async () => {
    await service.import(
      zipOf([
        ["my_hud/hud.json", manifest()],
        ["my_hud/index.html", "<html></html>"],
      ]),
      // Deliberately different from the folder: JTHud ignores the filename in
      // this branch, so we must too or we would record an id it never creates.
      "ignored-name.zip",
    );

    expect(paramsByName().jthudId).toBe("my_hud");
  });

  it("refuses an archive with no hud.json", async () => {
    await expect(
      service.import(zipOf([["index.html", "<html></html>"]]), "x.zip"),
    ).rejects.toThrow(/no hud\.json/i);
    expect(s3.put).not.toHaveBeenCalled();
  });

  it("refuses hud.json buried more than one level deep", async () => {
    await expect(
      service.import(zipOf([["a/b/hud.json", manifest()]]), "x.zip"),
    ).rejects.toThrow(/no hud\.json/i);
  });

  it("refuses a path that escapes the extraction directory", async () => {
    const archive = rawZipOf([
      ["hud.json", manifest()],
      ["../../etc/cron.d/pwn", "* * * * * root sh"],
    ]);
    // Guard the guard: prove the hostile name really survived into the archive,
    // so this test cannot quietly start passing for the wrong reason.
    expect(
      new AdmZip(archive).getEntries().map((e) => e.entryName),
    ).toContain("../../etc/cron.d/pwn");

    await expect(service.import(archive, "x.zip")).rejects.toThrow(
      /escapes it/i,
    );
    expect(s3.put).not.toHaveBeenCalled();
  });

  it("refuses an absolute path", async () => {
    const archive = rawZipOf([
      ["hud.json", manifest()],
      ["/etc/passwd", "root"],
    ]);
    expect(
      new AdmZip(archive).getEntries().map((e) => e.entryName),
    ).toContain("/etc/passwd");

    await expect(service.import(archive, "x.zip")).rejects.toThrow(
      /absolute path/i,
    );
  });

  it("refuses a windows drive-letter path", async () => {
    await expect(
      service.import(
        zipOf([
          ["hud.json", manifest()],
          ["C:/windows/system32/evil.dll", "MZ"],
        ]),
        "x.zip",
      ),
    ).rejects.toThrow(/absolute path/i);
  });

  it("ignores mac archive junk rather than rejecting the bundle", async () => {
    await service.import(
      zipOf([
        ["hud.json", manifest()],
        ["__MACOSX/._hud.json", "junk"],
        [".DS_Store", "junk"],
      ]),
      "mac.zip",
    );
    expect(s3.put).toHaveBeenCalled();
  });

  it("refuses something that is not a zip at all", async () => {
    await expect(
      service.import(Buffer.from("this is not a zip"), "x.zip"),
    ).rejects.toThrow(/readable zip/i);
  });

  it("refuses an empty upload", async () => {
    await expect(service.import(Buffer.alloc(0), "x.zip")).rejects.toThrow(
      /empty/i,
    );
  });

  it("records a signed bundle, and still imports it when hud.json will not parse", async () => {
    await service.import(
      zipOf([
        // A signed bundle's hud.json is a signature envelope, not plain JSON.
        ["hud.json", "-----BEGIN SIGNED-----\nnot json\n"],
        ["key", "-----BEGIN PUBLIC KEY-----"],
      ]),
      "signed-hud.zip",
    );

    const p = paramsByName();
    expect(p.isSigned).toBe(true);
    expect(p.hudJson).toBeNull();
    // Nothing to read a name out of, so the id it will install under is the name.
    expect(p.name).toBe("signed-hud");
  });

  it("inlines a thumbnail when the bundle carries one", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await service.import(
      zipOf([
        ["hud.json", manifest()],
        ["thumb.png", png],
      ]),
      "x.zip",
    );

    expect(paramsByName().thumbnail).toBe(
      `data:image/png;base64,${png.toString("base64")}`,
    );
  });

  it("suffixes the slug rather than colliding with an existing HUD", async () => {
    postgres.query.mockImplementation(
      async (sql: string, params: Array<unknown>) => {
        if (sql.includes("INSERT INTO public.broadcast_huds")) {
          inserted = params;
          return [{ slug: params[0] }];
        }
        if (sql.includes("SELECT slug FROM public.broadcast_huds")) {
          return params[0] === "test-hud" ? [{ slug: "test-hud" }] : [];
        }
        return [];
      },
    );

    await service.import(zipOf([["hud.json", manifest()]]), "x.zip");
    expect(paramsByName().slug).toBe("test-hud-2");
  });

  it("takes the stored object back out if the row insert fails", async () => {
    postgres.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO public.broadcast_huds")) {
        throw new Error("constraint violation");
      }
      return [];
    });

    await expect(
      service.import(zipOf([["hud.json", manifest()]]), "x.zip"),
    ).rejects.toThrow(/constraint violation/);
    expect(s3.remove).toHaveBeenCalledWith("broadcast-huds/test-hud.zip");
  });
});
