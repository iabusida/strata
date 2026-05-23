import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// API workspace is apps/api/src, while runtime env is kept at repository root.
dotenv.config({ path: resolve(__dirname, "../../../.env") });
