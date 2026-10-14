import { S3Service } from "./s3.service";

const DEMOS_DOMAIN = "demos.example.com";

const build = (
  endpoint: string,
  port: string,
  useSSL: boolean,
  overrides: { region?: string; forcePathStyle?: boolean } = {},
) => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const config = {
    get: () => ({
      key: "access-key",
      secret: "secret-key",
      bucket: "5stack",
      db_backup_bucket: "5stack-db-backups",
      endpoint,
      region: "us-east-1",
      useSSL,
      forcePathStyle: true,
      port,
      ...overrides,
    }),
  };

  return new S3Service(logger as never, config as never);
};

const hostOf = (url: string) => new URL(url).host;

// Exercised through getPresignedPartUrl because it shares endpointFor() and
// isInternalStore with every other signing path while staying on the AWS SDK.
// The files-sdk paths cannot be reached from here: it is ESM-only, and a real
// dynamic import inside jest's VM needs --experimental-vm-modules.
describe("S3Service presigned url routing", () => {
  const originalDomain = process.env.DEMOS_DOMAIN;

  beforeAll(() => {
    process.env.DEMOS_DOMAIN = DEMOS_DOMAIN;
  });

  afterAll(() => {
    // Assigning undefined would store the string "undefined" and leak that
    // into every later test in this worker.
    if (originalDomain === undefined) {
      delete process.env.DEMOS_DOMAIN;
      return;
    }

    process.env.DEMOS_DOMAIN = originalDomain;
  });

  // A URL signed against either in-cluster name is unreachable from the
  // browser doing the upload, so both have to route to the demos domain.
  describe.each(["rustfs", "minio"])("with S3_ENDPOINT=%s", (endpoint) => {
    it("signs multipart part uploads against the public demos domain", async () => {
      const url = await build(endpoint, "9000", false).getPresignedPartUrl(
        "key",
        "upload-id",
        1,
        60,
      );

      expect(hostOf(url)).toBe(DEMOS_DOMAIN);
    });

    it("carries the upload id and part number into the signature", async () => {
      const url = await build(endpoint, "9000", false).getPresignedPartUrl(
        "demos/match/big.dem",
        "upload-id",
        7,
        60,
      );

      const params = new URL(url).searchParams;

      expect(params.get("uploadId")).toBe("upload-id");
      expect(params.get("partNumber")).toBe("7");
    });
  });

  describe("with a remote bucket", () => {
    const endpoint = "s3.us-east-005.backblazeb2.com";

    it("signs against the remote host, not the demos domain", async () => {
      const url = await build(endpoint, "443", true).getPresignedPartUrl(
        "key",
        "upload-id",
        1,
        60,
      );

      expect(hostOf(url)).toBe(endpoint);
    });

    // A region that does not match the endpoint's puts the wrong scope in the
    // signature, and the store rejects every signed request.
    it("signs with the configured region", async () => {
      const url = await build(endpoint, "443", true, {
        region: "us-east-005",
      }).getPresignedPartUrl("key", "upload-id", 1, 60);

      const credential = new URL(url).searchParams.get(
        "X-Amz-Credential",
      ) as string;

      expect(credential).toContain("/us-east-005/s3/aws4_request");
    });

    it("addresses the bucket virtual-host style when path style is off", async () => {
      const url = await build(endpoint, "443", true, {
        forcePathStyle: false,
      }).getPresignedPartUrl("key", "upload-id", 1, 60);

      expect(hostOf(url)).toBe(`5stack.${endpoint}`);
    });
  });

  // Path style is forced for the in-cluster store regardless of config: it is
  // reached by Service name, and no DNS answers a bucket subdomain of it.
  describe.each(["rustfs", "minio"])(
    "with S3_ENDPOINT=%s and path style disabled",
    (endpoint) => {
      it("still addresses the bucket path style", async () => {
        const url = await build(endpoint, "9000", false, {
          forcePathStyle: false,
        }).getPresignedPartUrl("key", "upload-id", 1, 60);

        expect(hostOf(url)).toBe(DEMOS_DOMAIN);
        expect(new URL(url).pathname).toBe("/5stack/key");
      });
    },
  );
});

describe("S3Service.removePrefix", () => {
  const withClient = (deleted: Record<string, unknown>) => {
    const service = build("rustfs", "9000", false);
    const send = jest.fn(async (command: { constructor: { name: string } }) =>
      command.constructor.name === "ListObjectVersionsCommand"
        ? {
            Versions: [
              {
                Key: "chat-attachments/rooms/2026-10-01/a-1/file",
                VersionId: "v1",
              },
            ],
            IsTruncated: false,
          }
        : deleted,
    );

    (service as any).rawClients.set("internal", { send, destroy: jest.fn() });

    return { service, send };
  };

  it("counts what it removed", async () => {
    const { service } = withClient({});

    await expect(
      service.removePrefix("chat-attachments/rooms/2026-10-01/a-1/"),
    ).resolves.toBe(1);
  });

  const refused = {
    Errors: [
      {
        Key: "chat-attachments/rooms/2026-10-01/a-1/file",
        Code: "AccessDenied",
        Message: "no deleteFiles capability",
      },
    ],
  };

  // Match, clip and event deletes have always carried on past a key the store
  // refused; they log it rather than fail half way through.
  it("logs a key the store refused, and carries on", async () => {
    const { service } = withClient(refused);
    const warn = jest.spyOn((service as any).logger, "warn");

    await expect(
      service.removePrefix("chat-attachments/rooms/2026-10-01/a-1/"),
    ).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/AccessDenied/));
  });

  // DeleteObjects answers 200 even when it removed nothing. A caller whose
  // row is the only record of the file has to know, or it forgets a file that
  // is still being billed.
  it("fails a strict sweep when the store refused any of it", async () => {
    const { service } = withClient(refused);

    await expect(
      service.removePrefixStrictly("chat-attachments/rooms/2026-10-01/a-1/"),
    ).rejects.toThrow(/AccessDenied/);
  });
});

// getPresignedUrl is stubbed for the same reason as above: its files-sdk path
// cannot run here.
describe("S3Service presigned url origin", () => {
  it("is the origin of a url getPresignedUrl signs for the bucket", async () => {
    const service = build("s3.us-east-005.backblazeb2.com", "443", true, {
      forcePathStyle: false,
    });
    const sign = jest
      .spyOn(service, "getPresignedUrl")
      .mockResolvedValue(
        "https://5stack.s3.us-east-005.backblazeb2.com/probe?X-Amz-Signature=x",
      );

    await expect(service.getPresignedUrlOrigin()).resolves.toBe(
      "https://5stack.s3.us-east-005.backblazeb2.com",
    );

    // The default bucket, signed for outside the cluster like the URLs that
    // get handed to pods.
    const [, bucket, , , useLocal] = sign.mock.calls[0];
    expect(bucket).toBe("5stack");
    expect(useLocal).toBeFalsy();
  });
});
