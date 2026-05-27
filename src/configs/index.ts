import s3 from "./s3";
import redis from "./redis";
import postgres from "./postgres";
import app from "./app";
import discord from "./discord";
import steam from "./steam";
import hasura from "./hasura";
import gameServers from "./game-servers";
import typesense from "./typesense";
import tailscale from "./tailscale";
import faceit from "./faceit";

export default [
  app,
  discord,
  gameServers,
  hasura,
  postgres,
  redis,
  s3,
  steam,
  typesense,
  tailscale,
  faceit,
];
