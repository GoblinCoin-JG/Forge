import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { openDatabase } from "./db.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";

if (existsSync(".env")) loadEnvFile(".env");
const db = openDatabase(process.env.FORGE_DB_PATH || "./data/forge.sqlite");
const app = createApp(new Store(db));
app.addHook("onClose", async () => db.close());
const port = Number(process.env.PORT || 4310);
try {
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Forge is ready at http://127.0.0.1:${port}`);
} catch {
  console.error(
    `Forge could not start on port ${port}. Check that the port is free and the data directory is writable.`,
  );
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
