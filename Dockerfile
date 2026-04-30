ARG DEMO_PARSER_IMAGE=ghcr.io/5stackgg/demo-parser:latest

FROM node:22-alpine AS deps

WORKDIR /build
COPY package*.json ./
COPY yarn.lock ./

RUN yarn install

FROM node:22-alpine AS builder

WORKDIR /build
COPY --from=deps /build/node_modules ./node_modules
COPY . .

RUN yarn build

FROM ${DEMO_PARSER_IMAGE} AS demo-parser

FROM node:22-alpine

WORKDIR /opt/5stack

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/hasura ./hasura
COPY --from=demo-parser /usr/local/bin/demo-parser /usr/local/bin/demo-parser

CMD [ "node", "dist/src/main.js" ]
