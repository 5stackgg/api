import { S3Service } from "./s3.service";

const DEMOS_DOMAIN = "demos.example.com";

const build = (endpoint: string, port: string, useSSL: boolean) => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const config = {
    get: () => ({
      key: "access-key",
      secret: "secret-key",
      bucket: "5stack",
      db_backup_bucket: "5stack-db-backups",
      endpoint,
      useSSL,
      port,
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
    process.env.DEMOS_DOMAIN = originalDomain;
  });

  // Both names address the in-cluster object store: installs from before the
  // RustFS migration still carry S3_ENDPOINT=minio, and the panel keeps that
  // Service as an alias pointing at the same pods. A URL signed against either
  // in-cluster name is unreachable from the browser doing the upload.
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
  });
});
