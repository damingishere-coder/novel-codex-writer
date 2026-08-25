import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libraryRoot = resolve(frontendRoot, ".e2e-library");

if (dirname(libraryRoot) !== frontendRoot || !libraryRoot.endsWith(".e2e-library")) {
  throw new Error(`Refusing to reset unexpected E2E path: ${libraryRoot}`);
}

rmSync(libraryRoot, { recursive: true, force: true });
mkdirSync(resolve(libraryRoot, "作品"), { recursive: true });
mkdirSync(resolve(libraryRoot, ".trash"), { recursive: true });
