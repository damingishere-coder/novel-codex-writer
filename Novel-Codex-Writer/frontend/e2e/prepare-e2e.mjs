import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(frontendRoot, "..");
const libraryRoot = resolve(projectRoot, ".e2e-library");

if (dirname(libraryRoot) !== projectRoot || !libraryRoot.endsWith(".e2e-library")) {
  throw new Error(`Refusing to reset unexpected E2E path: ${libraryRoot}`);
}

rmSync(libraryRoot, { recursive: true, force: true });
mkdirSync(resolve(libraryRoot, "作品"), { recursive: true });
mkdirSync(resolve(libraryRoot, ".trash"), { recursive: true });
