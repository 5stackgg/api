import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { Readable } from "stream";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { S3Service } from "../s3/s3.service";

const ID = "0b7d6c1e-1111-4a2b-9c3d-000000000001";
const PART = ChatAttachmentsService.PART_SIZE;
const IDLE_MS = 400;

// A store that takes the whole part and then never answers, through the real
// S3 client: the player's upload slots must not wait on it.
describe("ChatAttachmentsService, a store that never answers a part", () => {
  let server: Server;
  let held: ServerResponse[];
  let s3: S3Service;
  let service: ChatAttachmentsService;
  const originalIdle = (S3Service as any).PART_IDLE_TIMEOUT_MS;

  const row = {
    id: ID,
    uploader_steam_id: "1",
    room_type: "matchmaking",
    room_id: "lobby-1",
    storage_prefix: `chat-attachments/rooms/2026-10-02/${ID}/`,
    file_name: "clip.mp4",
    mime_type: "video/mp4",
    size: String(PART * 3),
    width: null,
    height: null,
    duration_ms: null,
    poster_mime_type: null,
    upload_id: "upload-1",
    message_id: null,
    deleted_at: null,
  };

  beforeAll(async () => {
    held = [];
    server = createServer((request: IncomingMessage, response) => {
      request.resume();
      request.on("end", () => held.push(response));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    (S3Service as any).PART_IDLE_TIMEOUT_MS = IDLE_MS;

    const { port } = server.address() as AddressInfo;
    s3 = new S3Service(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {
        get: () => ({
          key: "access-key",
          secret: "secret-key",
          bucket: "5stack",
          endpoint: "127.0.0.1",
          port: String(port),
          useSSL: false,
          region: "us-east-1",
          forcePathStyle: true,
        }),
      } as any,
    );

    service = new ChatAttachmentsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {
        query: jest.fn(async (sql: string) =>
          sql.includes("upload_id IS NOT NULL") ? [row] : [],
        ),
      } as any,
      s3,
    );
  });

  afterAll(async () => {
    (S3Service as any).PART_IDLE_TIMEOUT_MS = originalIdle;
    s3.onModuleDestroy();
    for (const response of held) {
      response.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  it("gives up once the store goes quiet, and frees the player's slots", async () => {
    const started = Date.now();

    await expect(
      service.uploadPart("1", ID, 2, Readable.from([Buffer.alloc(PART)]), PART),
    ).resolves.toBe(ChatErrorCode.Unavailable);

    expect(Date.now() - started).toBeLessThan(IDLE_MS + 4_000);
    expect((service as any).uploadsInFlight).toBe(0);
    expect((service as any).uploadsByPlayer.size).toBe(0);
  }, 15_000);

  it("waits on a store that is quiet for less than the idle limit", () => {
    expect(originalIdle).toBeGreaterThanOrEqual(30_000);
  });
});
