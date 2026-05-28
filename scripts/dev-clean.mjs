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

killPort(8787);
killPort(3000);