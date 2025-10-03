export type S3Config = {
  key: string;
  secret: string;
  bucket: string;
  db_backup_bucket: string;
  endpoint: string;
  useSSL: boolean;
  port: string;
};
