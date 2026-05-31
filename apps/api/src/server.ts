import "./env.js";
import { loadRuntimeSettingsToProcessEnvOrThrow } from "./runtime-settings.js";

async function bootstrap(): Promise<void> {
  await loadRuntimeSettingsToProcessEnvOrThrow();
  await import("./server-app.js");
}

void bootstrap().catch((error) => {
  console.error("[bootstrap] Failed to load runtime settings; refusing to start", error);
  process.exit(1);
});
