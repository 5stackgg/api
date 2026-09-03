import { S3Config } from "./types/S3Config";

export default (): {
  s3: S3Config;
} => ({
  s3: {
    key: process.env.S3_ACCESS_KEY,
    secret: process.env.S3_SECRET,
    bucket: process.env.S3_BUCKET,
    db_backup_bucket: process.env.S3_DB_BACKUP_BUCKET || "5stack-db-backups",
    endpoint: process.env.S3_ENDPOINT || "rustfs",
    // SigV4 puts the region in the credential scope, so a remote bucket whose
    // region this does not match rejects every signature. The in-cluster store
    // accepts any region, which is why this can have a default at all.
    region: process.env.S3_REGION || "us-east-1",
    useSSL: process.env.S3_USE_SSL === "true" ? true : false,
    // AWS dropped path-style addressing for buckets created after Sept 2020,
    // so a real AWS endpoint needs this off. Every other S3 implementation
    // 5stack targets accepts path style, and the in-cluster store requires it.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    port: process.env.S3_PORT || "9000",
  },
});
