import { S3Config } from "./types/S3Config";

export default (): {
  s3: S3Config;
} => ({
  s3: {
    key: process.env.S3_ACCESS_KEY,
    secret: process.env.S3_SECRET,
    bucket: process.env.S3_BUCKET,
    endpoint: process.env.S3_ENDPOINT || "minio",
    useSSL: process.env.S3_USE_SSL ? process.env.S3_USE_SSL === "true" : false,
    port: process.env.S3_PORT || "9090",
  },
});
