import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the app's non-code assets live.
 *
 * Four modules used to work this out independently from their own file depth
 * (`../..` from src/db, `../../prompts` from src/llm, and so on). That is fine
 * while every file runs from src/, and breaks in a different way in each file
 * the moment the code is compiled or bundled, because they all collapse to one
 * location. One calculation, used everywhere, keeps the built image and the
 * dev tree agreeing.
 *
 * `dist/` is deliberately the same depth as `src/`, so this resolves to the
 * application root either way and the assets sit beside it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function appRoot(): string {
  return ROOT;
}

export function promptsDir(): string {
  return join(ROOT, "prompts");
}

export function templatesDir(): string {
  return join(ROOT, "templates");
}

export function migrationsDir(): string {
  return join(ROOT, "migrations");
}
