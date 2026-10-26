import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Claude Desktop starts the server from an unpredictable cwd, so everything is
// resolved from this file's location: src/ (vitest) or dist/ (built) → project root.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ENV_PATH = join(ROOT, ".env");
export const RESULTS_DIR = join(ROOT, "results");
export const CACHE_DIR = join(ROOT, ".cache");
