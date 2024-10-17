import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";

@Controller("system")
export class SystemController {
  @HasuraAction()
  public async versions() {
    console.info("WEEE");
  }

  @HasuraAction()
  public async systemUpdate() {}
}
