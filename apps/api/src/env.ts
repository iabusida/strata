import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env from repo root and API workspace. Later files override earlier ones.
const envFiles = [
	resolve(__dirname, "../../../.env"),
	resolve(__dirname, "../../../.env.local"),
	resolve(__dirname, "../.env"),
	resolve(__dirname, "../.env.local"),
];

for (const path of envFiles) {
	dotenv.config({ path, override: true });
}
