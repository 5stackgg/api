import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  Server,
} from "http";
import { AddressInfo } from "net";
import { Readable, Writable } from "stream";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";

const ID = "0b7d6c1e-1111-4a2b-9c3d-000000000001";
const PART = ChatAttachmentsService.PART_SIZE;

// A real socket that goes away mid-body, against storage that does what the
// AWS SDK does with a body: pipe it, and listen for nothing else on it.
describe("ChatAttachmentsService, a part whose sender goes away", () => {
  let server: Server;
  let service: ChatAttachmentsService;
  let sends: Array<{ signal?: AbortSignal; settled: Promise<unknown> }>;
  let queries: string[];
  let arrived: () => void;
  let started: Promise<void>;
  let result: Promise<ChatErrorCode | null>;

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

  const s3 = {
    uploadPart: jest.fn(
      (
        _key: string,
        _uploadId: string,
        _part: number,
        body: Readable,
        _length: number,
        signal?: AbortSignal,
      ) => {
        const settled = new Promise<void>((resolve, reject) => {
          const sink = new Writable({
            write(_chunk, _encoding, callback) {
              arrived();
              callback();
            },
          });

          body.pipe(sink);
          sink.on("finish", () => resolve());
          signal?.addEventListener("abort", () =>
            reject(new Error("request aborted")),
          );
        });

        sends.push({ signal, settled: settled.catch(() => {}) });

        return settled;
      },
    ),
  };

  const postgres = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return sql.includes("upload_id IS NOT NULL") ? [row] : [];
    }),
  };

  beforeEach(async () => {
    sends = [];
    queries = [];
    started = new Promise((resolve) => {
      arrived = resolve;
    });

    service = new ChatAttachmentsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      s3 as any,
    );

    server = createServer((request: IncomingMessage) => {
      result = service.uploadPart("1", ID, 2, request, PART);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const abortMidBody = async () => {
    const { port } = server.address() as AddressInfo;

    const client = httpRequest({
      port,
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(PART),
      },
    });
    client.on("error", () => {});

    client.write(Buffer.alloc(300 * 1024));
    await started;
    client.destroy();

    return await result;
  };

  it("survives, refuses the part, and lets go of the request to storage", async () => {
    await expect(abortMidBody()).resolves.toBe(ChatErrorCode.Invalid);

    expect(sends).toHaveLength(1);
    expect(sends[0].signal?.aborted).toBe(true);
    await sends[0].settled;
  });

  it("frees the player's upload slots for the next try", async () => {
    await abortMidBody();

    expect((service as any).uploadsInFlight).toBe(0);
    expect((service as any).uploadsByPlayer.size).toBe(0);
  });

  it("leaves the upload for the sweep to abort", async () => {
    await abortMidBody();

    expect(
      queries.filter(
        (sql) =>
          sql.includes("DELETE FROM public.chat_attachments") ||
          sql.includes("SET expires_at") ||
          sql.includes("SET upload_id = NULL"),
      ),
    ).toEqual([]);
  });
});
