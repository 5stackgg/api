import { Controller } from "@nestjs/common";
import { SystemService } from "./system.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get("health")
  public async status() {
    return "OK";
  }

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();

    return {
      success: true,
    };
  }
}
