import { createHmac } from "crypto";
import { FileUrlSigningService } from "./file-url-signing.service";

const S3_SECRET = "bucket-secret";
const DERIVED = createHmac("sha256", S3_SECRET)
  .update("5stack-file-url-v1")
  .digest();

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FileUrlSigningService", () => {
  let postgres: { query: jest.Mock };
  let logger: { warn: jest.Mock };

  const service = () =>
    new FileUrlSigningService(
      logger as any,
      { get: () => ({ secret: S3_SECRET }) } as any,
      postgres as any,
    );

  beforeEach(() => {
    postgres = { query: jest.fn() };
    logger = { warn: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The computed fields sign only once the key is stored, so a pod that boots
  // after the migrations must not serve a request before it is.
  it("does not finish booting until the key is stored", async () => {
    const insert = deferred();
    postgres.query.mockReturnValueOnce(insert.promise);

    let booted = false;
    const boot = service()
      .onApplicationBootstrap()
      .then(() => {
        booted = true;
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(booted).toBe(false);
    expect(postgres.query).toHaveBeenCalledTimes(1);
    expect(postgres.query.mock.calls[0][0]).toContain(
      "private.file_url_signing_key",
    );
    expect(
      Buffer.from(postgres.query.mock.calls[0][1][0]).equals(DERIVED),
    ).toBe(true);

    insert.resolve();
    await boot;
    expect(booted).toBe(true);
  });

  // Hasura's init container can still be migrating when the api boots.
  it("boots anyway when the table is not there yet, and stores the key within seconds of it appearing", async () => {
    jest.useFakeTimers();
    postgres.query
      .mockRejectedValueOnce(
        new Error('relation "private.file_url_signing_key" does not exist'),
      )
      .mockRejectedValueOnce(
        new Error('relation "private.file_url_signing_key" does not exist'),
      )
      .mockResolvedValue([]);

    await service().onApplicationBootstrap();
    expect(postgres.query).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(postgres.query).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(postgres.query).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(postgres.query).toHaveBeenCalledTimes(3);
  });
});
