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
