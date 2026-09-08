import { serve } from "@hono/node-server";
import { createApplication } from "./app.ts";

const app = createApplication();
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Listening on http://${info.address}:${info.port}/`);
});
