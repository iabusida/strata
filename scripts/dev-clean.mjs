import { execFileSync } from "node:child_process";

function killPort(port) {
  try {
    const output = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).trim();
    if (!output) {
      return;
    }

    for (const pid of output.split(/\s+/)) {
      if (pid) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Ignore processes that disappear between lsof and kill.
        }
      }
    }
  } catch {
    // No process bound to the port.
  }
}

function killByPattern(pattern) {
  try {
    const output = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim();
    if (!output) {
      return;
    }

    for (const pid of output.split(/\s+/)) {
      if (!pid) {
        continue;
      }

      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Ignore processes that disappear between pgrep and kill.
      }
    }
  } catch {
    // No process matching the pattern.
  }
}

killPort(8787);
killPort(3000);

// Also kill orphan watcher processes for this workspace.
killByPattern("/Users/islam/dev/hype-trading/node_modules/.bin/tsx watch src/server.ts");
killByPattern("/Users/islam/dev/hype-trading/node_modules/tsx/dist/loader.mjs src/server.ts");
killByPattern("/Users/islam/dev/hype-trading/node_modules/.bin/next dev");