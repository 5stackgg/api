import { Controller, Logger } from "@nestjs/common";
import { EventPattern } from "@nestjs/microservices";
import { SocketsService } from "./sockets.service";

@Controller("sockets")
export class SocketsController {
  constructor(
    private readonly logger: Logger,
    private readonly sockets: SocketsService,
  ) {}

  @EventPattern("answer")
  public async handleAnswer(data: any) {
    await this.handleCandidate(data);
  }

  @EventPattern("candidate")
  public async handleCandidate(data: any) {
    const { peerId, clientId, signal } = data;

    if (!peerId || !clientId) {
      this.logger.error("No peerId or clientId found");
      return;
    }

    await this.sockets.sendMessageToClient(clientId, "candidate", {
      peerId,
      signal,
    });
  }
}
