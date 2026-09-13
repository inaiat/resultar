import { createApplication } from "./app.ts";

const app = await createApplication({
  findById: async (id) => (id === "1" ? { id, name: "Ada" } : undefined),
});

await app.listen({ port: 3000, host: "127.0.0.1" });
process.once("SIGINT", () => {
  app.close().catch((error) => {
    app.log.error(error);
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  app.close().catch((error) => {
    app.log.error(error);
    process.exitCode = 1;
  });
});
