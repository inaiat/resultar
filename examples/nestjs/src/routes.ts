import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { Services, type InferRequestServices, type NestRequest } from "resultar-nestjs";
import type { createServices } from "./services.ts";

type RequestServices = InferRequestServices<ReturnType<typeof createServices>>;

type StatusResponse = {
  status(code: number): unknown;
};

@Controller("users")
export class UsersController {
  @Get(":id")
  async findById(
    @Param("id") id: string,
    @Services() services: RequestServices,
    @Req() request: NestRequest,
    @Res({ passthrough: true }) res: StatusResponse,
  ) {
    const result = await services.users.findById(id).runResult({ signal: request.signal });
    return result.matchTags(
      (user) => {
        res.status(200);
        return user;
      },
      {
        UserNotFoundError: (error) => {
          res.status(404);
          return { error: error.message };
        },
        UserReadError: (error) => {
          request.log.error({ err: error }, "User lookup failed");
          res.status(503);
          return { error: "Temporarily unavailable" };
        },
      },
    );
  }
}

@Controller("health")
export class HealthController {
  @Get()
  async check(
    @Services() services: RequestServices,
    @Res({ passthrough: true }) res: StatusResponse,
  ) {
    const result = await services.health.check().runResult();
    return result.match(
      (health) => {
        res.status(200);
        return health;
      },
      () => {
        res.status(503);
        return { error: "Health unavailable" };
      },
    );
  }
}
