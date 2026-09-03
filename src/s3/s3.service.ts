import { Readable } from "stream";
import { Request } from "express";
import { ConfigService } from "@nestjs/config";
import { S3Config } from "../configs/types/S3Config";
import { Injectable, Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3ObjectInfo {
  name: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export interface S3StatInfo {
  size: number;
  etag?: string;
  lastModified?: Date;
  metaData: Record<string, string>;
}

type FilesSdk = typeof import("files-sdk");
type Files = InstanceType<FilesSdk["Files"]>;
type StoredFile = import("files-sdk").StoredFile;

interface S3Modules {
  Files: FilesSdk["Files"];
  s3: (options: Record<string, unknown>) => never;
}

// files-sdk is ESM-only -- its package exports declare no `require` condition,
// so a plain import compiled to CJS dies with ERR_PACKAGE_PATH_NOT_EXPORTED.
// The api is a CommonJS NestJS build, and tsc rewrites a literal `import()` in
// that mode into exactly the `require()` that cannot work. Going through the
// Function constructor is what keeps a genuine dynamic import in the output.
const importESM = new Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;

@Injectable()
export class S3Service {
  private bucket: string;
  private config: S3Config;
  private modules?: Promise<S3Modules>;

  private readonly clients = new Map<string, Files>();
  private readonly rawClients = new Map<string, S3Client>();

  constructor(
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {
    this.config = this.configService.get("s3");
    this.bucket = this.config.bucket;
  }

  public get bucketName(): string {
    return this.bucket;
  }

  // Loaded on first use rather than in the constructor: a dynamic import
  // cannot run inside jest's VM without --experimental-vm-modules, and an
  // eager one would make every test that merely constructs this service fail.
  private loadModules(): Promise<S3Modules> {
    if (!this.modules) {
      this.modules = Promise.all([
        importESM<FilesSdk>("files-sdk"),
        importESM<{ s3: S3Modules["s3"] }>("files-sdk/s3"),
      ]).then(([core, adapter]) => ({ Files: core.Files, s3: adapter.s3 }));
    }

    return this.modules;
  }

  private endpointFor(external: boolean): string {
    if (external) {
      return `https://${process.env.DEMOS_DOMAIN}`;
    }

    const protocol = this.config.useSSL ? "https" : "http";

    return `${protocol}://${this.config.endpoint}:${this.config.port}`;
  }

  private get credentials() {
    return {
      accessKeyId: this.config.key,
      secretAccessKey: this.config.secret,
    };
  }

  // The in-cluster object store is addressed by its Kubernetes Service name.
  // Both names resolve to the same pods: installs that predate the RustFS
  // migration still carry S3_ENDPOINT=minio, and the panel keeps that Service
  // as an alias. Anything else is a real remote bucket.
  private get isInternalStore(): boolean {
    return this.config.endpoint === "rustfs" || this.config.endpoint === "minio";
  }

  private async files(
    bucket: string = this.bucket,
    external: boolean = false,
  ): Promise<Files> {
    const scope = `${external ? "external" : "internal"}:${bucket}`;

    const cached = this.clients.get(scope);
    if (cached) {
      return cached;
    }

    const { Files, s3 } = await this.loadModules();

    const client = new Files({
      adapter: s3({
        bucket,
        endpoint: this.endpointFor(external),
        region: process.env.S3_REGION || "us-east-1",
        forcePathStyle: true,
        credentials: this.credentials,
      }),
    });

    this.clients.set(scope, client);

    return client;
  }

  // The multipart and object-version primitives below have no files-sdk
  // equivalent -- it drives multipart uploads from its own process and has no
  // way to hand a client a per-part signed URL, and its versioning plugin
  // snapshots to a key prefix rather than using real S3 object versions. They
  // talk to the AWS SDK directly rather than reaching through files.raw, which
  // also keeps them clear of the ESM import.
  private raw(
    bucket: string = this.bucket,
    external: boolean = false,
  ): S3Client {
    const scope = `${external ? "external" : "internal"}:${bucket}`;

    const cached = this.rawClients.get(scope);
    if (cached) {
      return cached;
    }

    const client = new S3Client({
      endpoint: this.endpointFor(external),
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: true,
      credentials: this.credentials,
    });

    this.rawClients.set(scope, client);

    return client;
  }

  private static toObjectInfo(file: StoredFile): S3ObjectInfo {
    return {
      name: file.key,
      size: file.size,
      etag: file.etag,
      lastModified: file.lastModified
        ? new Date(file.lastModified)
        : undefined,
    };
  }

  public multerStorage(
    uploadPath: (request: Request, file: Express.Multer.File) => string,
  ) {
    return {
      _handleFile: async (
        request: Request,
        file: Express.Multer.File,
        callback: (error?: string, file?: Express.Multer.File) => void,
      ) => {
        try {
          await this.put(uploadPath(request, file), file.stream);

          request.file = file;

          callback(null, file);
        } catch (error) {
          callback(error);
        }
      },
      _removeFile: async (
        request: Request,
        file: Express.Multer.File,
        callback: (error?: string) => void,
      ) => {
        try {
          await this.remove(uploadPath(request, file));
          callback();
        } catch (error) {
          callback(error);
        }
      },
    };
  }

  public async list(bucket: string = this.bucket): Promise<S3ObjectInfo[]> {
    const objects: S3ObjectInfo[] = [];

    for await (const object of this.listStream("", true, bucket)) {
      objects.push(object);
    }

    return objects;
  }

  public async *listStream(
    prefix: string = "",
    recursive: boolean = true,
    bucket: string = this.bucket,
  ): AsyncGenerator<S3ObjectInfo> {
    const client = await this.files(bucket);

    // A non-recursive listing is the "folder" view: a delimiter collapses
    // everything below the prefix into common prefixes, which listAll drops.
    for await (const file of client.listAll({
      prefix,
      ...(recursive ? {} : { delimiter: "/" }),
    })) {
      yield S3Service.toObjectInfo(file);
    }
  }

  public async get(
    filename: string,
    bucket: string = this.bucket,
  ): Promise<Readable> {
    const client = await this.files(bucket);
    const file = await client.download(filename, { as: "stream" });

    return Readable.fromWeb(file.stream() as never);
  }

  public async getPartial(
    filename: string,
    offset: number,
    length: number,
    bucket: string = this.bucket,
  ): Promise<Readable> {
    const client = await this.files(bucket);

    // files-sdk's range end is inclusive, so the last byte of a `length`-long
    // window is offset + length - 1. Passing offset + length reads one byte
    // too many.
    const file = await client.download(filename, {
      as: "stream",
      range: { start: offset, end: offset + length - 1 },
    });

    return Readable.fromWeb(file.stream() as never);
  }

  public async readPrefix(
    filename: string,
    length: number,
    bucket: string = this.bucket,
  ): Promise<Buffer> {
    const stream = await this.getPartial(filename, 0, length, bucket);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  public async put(
    filename: string,
    stream: Readable | Buffer,
    contentType?: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    const client = await this.files(bucket);

    const body =
      stream instanceof Readable
        ? (Readable.toWeb(stream) as never)
        : new Uint8Array(stream);

    await client.upload(filename, body, {
      ...(contentType ? { contentType } : {}),
      // Demos and clips routinely run to hundreds of megabytes, and a stream
      // body has no length to size a single PUT from.
      multipart: true,
    });
  }

  public async copyObject(
    fromKey: string,
    toKey: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    const client = await this.files(bucket);
    await client.copy(fromKey, toKey);
  }

  public async stat(
    filename: string,
    bucket: string = this.bucket,
  ): Promise<S3StatInfo> {
    const client = await this.files(bucket);
    const file = await client.head(filename);

    return {
      size: file.size,
      etag: file.etag,
      lastModified: file.lastModified
        ? new Date(file.lastModified)
        : undefined,
      metaData: {
        ...file.metadata,
        ...(file.type ? { "content-type": file.type } : {}),
      },
    };
  }

  public async removePrefix(
    prefix: string,
    bucket: string = this.bucket,
  ): Promise<number> {
    const client = this.raw(bucket);

    let removed = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    // Every version has to go, not just the current one: on a versioned bucket
    // a plain delete only lays down a delete marker, and the objects it hides
    // keep being billed forever.
    do {
      const listed = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );

      const entries = [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ]
        .filter((entry) => !!entry.Key)
        .map((entry) => ({
          Key: entry.Key,
          ...(entry.VersionId && entry.VersionId !== "null"
            ? { VersionId: entry.VersionId }
            : {}),
        }));

      for (let i = 0; i < entries.length; i += 1000) {
        const batch = entries.slice(i, i + 1000);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch },
          }),
        );
        removed += batch.length;
      }

      keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = listed.IsTruncated
        ? listed.NextVersionIdMarker
        : undefined;
    } while (keyMarker || versionIdMarker);

    return removed;
  }

  public async removeKeys(
    keys: string[],
    bucket: string = this.bucket,
  ): Promise<number> {
    const client = await this.files(bucket);

    let removed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await client.delete(batch);
      removed += batch.length;
    }
    return removed;
  }

  public async remove(
    filename: string,
    bucket: string = this.bucket,
  ): Promise<boolean> {
    try {
      const client = await this.files(bucket);
      await client.delete(filename);
    } catch (error) {
      this.logger.error("unable to remove", error.code ?? error.message);
      return false;
    }
    return true;
  }

  public async has(
    filepath: string,
    bucket: string = this.bucket,
  ): Promise<boolean> {
    const client = await this.files(bucket);
    return await client.exists(filepath);
  }

  public async getPresignedUrl(
    key: string,
    bucket: string = this.bucket,
    // 5 minutes
    expires = 60 * 5,
    type: "put" | "get" = "put",
    useLocal: boolean = false,
  ) {
    // A URL signed against the in-cluster Service name is unreachable from a
    // browser or a game server node, so those are signed against the public
    // demos domain instead. useLocal is for callers that read the object back
    // from inside the cluster.
    const external = !useLocal && this.isInternalStore;
    const client = await this.files(bucket, external);

    if (type === "put") {
      const upload = await client.signedUploadUrl(key, { expiresIn: expires });
      return upload.url;
    }

    return await client.url(key, { expiresIn: expires });
  }

  public async createMultipartUpload(
    key: string,
    bucket: string = this.bucket,
  ): Promise<string> {
    const client = this.raw(bucket);

    const upload = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );

    return upload.UploadId;
  }

  public async getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expires = 60 * 60 * 6,
    bucket: string = this.bucket,
  ): Promise<string> {
    const client = this.raw(bucket, this.isInternalStore);

    return await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expires },
    );
  }

  public async completeMultipartUpload(
    key: string,
    uploadId: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    const client = this.raw(bucket);

    const listed = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );

    const parts = listed.Parts ?? [];
    if (parts.length === 0) {
      throw new Error("no parts uploaded");
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.PartNumber - b.PartNumber)
            .map((part) => ({
              PartNumber: part.PartNumber,
              ETag: part.ETag,
            })),
        },
      }),
    );
  }

  public async abortMultipartUpload(
    key: string,
    uploadId: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    const client = this.raw(bucket);

    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }
}
