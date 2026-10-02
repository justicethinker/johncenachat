import { createAsideServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const server = createAsideServer();

server.listen(port).catch((error: unknown) => {
  // Fatal startup errors only. No room ids, no addresses, ever.
  console.error(
    "aside relay failed to start:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
