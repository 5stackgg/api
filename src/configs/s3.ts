import { S3Config } from "./types/S3Config";

export default (): {
  s3: S3Config;
} => ({
  s3: {
    key: process.env.S3_ACCESS_KEY,
    secret: process.env.S3_SECRET,
    bucket: process.env.S3_BUCKET,
    db_backup_bucket: process.env.S3_DB_BACKUP_BUCKET,
    endpoint: process.env.S3_ENDPOINT || process.env.DEMOS_DOMAIN,
    useSSL: process.env.S3_USE_SSL === "false" ? false : true,
    port: process.env.S3_PORT || "443",
  },
});
