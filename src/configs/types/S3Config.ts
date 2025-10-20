export type S3Config = {
  key: string;
  secret: string;
  bucket: string;
  db_backup_bucket: string;
  endpoint: string;
  directEndpoint?: string;
  directPort?: string;
  directUseSSL?: boolean;
  useSSL: boolean;
  port: string;
};
