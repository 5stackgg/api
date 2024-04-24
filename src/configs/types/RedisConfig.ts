export type RedisConfig = {
  connections: Record<
    string,
    {
      db: number;
      host: string;
      port: number;
      password: string;
    }
  >;
};
