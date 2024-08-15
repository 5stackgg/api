FROM node:22-alpine As build

WORKDIR /build

COPY package*.json ./
COPY yarn.lock ./

RUN yarn

COPY . .

RUN yarn build

FROM node:22-alpine

WORKDIR /opt/5stack

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

CMD [ "node", "dist/src/main.js" ]
