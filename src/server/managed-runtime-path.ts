/**
 * PATH bootstrap for tools spawned by Hermes-managed runtimes.
 *
 * Paperclip can be launched by a GUI app, service manager, or package runner
 * with a much narrower PATH than an interactive shell. Hermes may then start
 * successfully while a nested runtime such as Codex fails with ENOENT because
 * Python's subprocess lookup cannot find the `codex` executable.
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as nodePath from "node:path";
import { homedir } from "node:os";

export type ManagedRuntimePathResult = {
  path: string;
  addedDirs: string[];
  executables: Record<string, string | null>;
};

function splitPath(value: string | undefined): string[] {
  return (value ?? "")
    .split(nodePath.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function candidateHomeDir(relativePath: string): string {
  return nodePath.join(homedir(), relativePath);
}

function ancestorNodeBinDirs(startDir: string): string[] {
  const out: string[] = [];
  let current = nodePath.resolve(startDir);

  for (let depth = 0; depth < 8; depth += 1) {
    out.push(nodePath.join(current, "node_modules", ".bin"));
    const parent = nodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return out;
}

function knownExecutableDirs(): string[] {
  const out = [
    process.env.PNPM_HOME,
    process.env.NVM_BIN,
    process.env.VOLTA_HOME ? nodePath.join(process.env.VOLTA_HOME, "bin") : undefined,
    process.env.BUN_INSTALL ? nodePath.join(process.env.BUN_INSTALL, "bin") : undefined,
    process.env.npm_config_prefix ? nodePath.join(process.env.npm_config_prefix, "bin") : undefined,
    nodePath.dirname(process.execPath),
    candidateHomeDir(".local/bin"),
    candidateHomeDir(".npm-global/bin"),
    candidateHomeDir(".bun/bin"),
    candidateHomeDir(".cargo/bin"),
    candidateHomeDir(".deno/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...ancestorNodeBinDirs(process.cwd()),
  ];

  return out.filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
}

function uniqueDirs(dirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const normalized = nodePath.resolve(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(dir);
  }

  return out;
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command: string, pathValue: string): Promise<string | null> {
  const names = process.platform === "win32"
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

  for (const dir of splitPath(pathValue)) {
    for (const name of names) {
      const candidate = nodePath.join(dir, name);
      if (await executableExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function bootstrapManagedRuntimePath(
  env: Record<string, string>,
  options: {
    extraDirs?: string[];
    extraSearchRoots?: string[];
    executables?: string[];
  } = {},
): Promise<ManagedRuntimePathResult> {
  const existingDirs = splitPath(env.PATH);
  const allDirs = uniqueDirs([
    ...existingDirs,
    ...(options.extraDirs ?? []),
    ...(options.extraSearchRoots ?? []).flatMap((root) => ancestorNodeBinDirs(root)),
    ...knownExecutableDirs(),
  ]);
  const addedDirs = allDirs.filter((dir) => !existingDirs.includes(dir));
  const pathValue = allDirs.join(nodePath.delimiter);

  env.PATH = pathValue;

  const executables: Record<string, string | null> = {};
  for (const executable of options.executables ?? ["codex"]) {
    executables[executable] = await resolveExecutable(executable, pathValue);
  }

  return {
    path: pathValue,
    addedDirs,
    executables,
  };
}
