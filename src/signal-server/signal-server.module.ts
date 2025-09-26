import { Module } from "@nestjs/common";
import { HasuraModule } from "src/hasura/hasura.module";
import { SignalServerGateway } from "./signal-server.gateway";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  imports: [HasuraModule],
  providers: [SignalServerGateway, loggerFactory()],
})
export class SignalServerModule {}
