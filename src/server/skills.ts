import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  resolvePaperclipDesiredSkillNames,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_CORE_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];
const PAPERCLIP_SERVER_SKILLS_RELATIVE_CANDIDATES = [
  "node_modules/@paperclipai/server/skills",
  "../server/skills",
  "../../server/skills",
];
const DEFAULT_WORKSPACE_SKILLS_DIR = "/srv/paperclip/repo/skills";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

function configuredStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function uniquePaths(candidates: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function resolveWorkspaceDir(config: Record<string, unknown>): string | null {
  return (
    asString(config.workspaceDir) ??
    asString(config.cwd) ??
    asString(process.env.PAPERCLIP_WORKSPACE_DIR) ??
    path.dirname(DEFAULT_WORKSPACE_SKILLS_DIR)
  );
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `~/.hermes/skills/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

async function isDirectory(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then((stats) => stats.isDirectory()).catch(() => false);
}

async function resolveFirstExistingDirectory(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return null;
}

function configuredRuntimeSkillEntries(config: Record<string, unknown>): PaperclipSkillEntry[] {
  const raw = config.paperclipRuntimeSkills;
  if (!Array.isArray(raw)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const key = asString(entry.key) ?? asString(entry.name);
    const runtimeName = asString(entry.runtimeName) ?? asString(entry.name);
    const source = asString(entry.source);
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source: path.resolve(source),
      required: entry.required === true,
      requiredReason: asString(entry.requiredReason),
    });
  }
  return out;
}

function coreSkillRootCandidates(
  config: Record<string, unknown>,
  moduleDir: string,
  _companyId?: string | null,
): string[] {
  return uniquePaths([
    asString(config.paperclipCoreSkillsDir),
    asString(process.env.PAPERCLIP_CORE_SKILLS_DIR),
    ...configuredStringArray(config.paperclipCoreSkillDirs),
    ...PAPERCLIP_CORE_SKILL_ROOT_RELATIVE_CANDIDATES.map((relative) => path.resolve(moduleDir, relative)),
    ...PAPERCLIP_SERVER_SKILLS_RELATIVE_CANDIDATES.map((relative) => path.resolve(process.cwd(), relative)),
    ...PAPERCLIP_SERVER_SKILLS_RELATIVE_CANDIDATES.map((relative) => path.resolve(os.homedir(), relative)),
    path.join(os.homedir(), ".npm-global/lib/node_modules/paperclipai/node_modules/@paperclipai/server/skills"),
    path.join(os.homedir(), ".npm-global/lib/node_modules/@paperclipai/server/skills"),
  ]);
}

function workspaceSkillRootCandidates(config: Record<string, unknown>): string[] {
  const workspaceDir = resolveWorkspaceDir(config);
  return uniquePaths([
    asString(config.paperclipWorkspaceSkillsDir),
    asString(config.workspaceSkillsDir),
    asString(process.env.PAPERCLIP_WORKSPACE_SKILLS_DIR),
    ...configuredStringArray(config.paperclipWorkspaceSkillDirs),
    workspaceDir ? path.join(workspaceDir, "skills") : null,
    DEFAULT_WORKSPACE_SKILLS_DIR,
  ]);
}

async function listFlatSkillEntries(options: {
  root: string;
  keyPrefix: string;
  required: boolean;
  requiredReason?: string | null;
}): Promise<PaperclipSkillEntry[]> {
  const entries = await fs.readdir(options.root, { withFileTypes: true }).catch(() => []);
  const out: PaperclipSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const source = path.join(options.root, entry.name);
    const skillMdPath = path.join(source, "SKILL.md");
    const hasSkill = await fs.stat(skillMdPath).then((stats) => stats.isFile()).catch(() => false);
    if (!hasSkill) continue;
    out.push({
      key: `${options.keyPrefix}/${entry.name}`,
      runtimeName: entry.name,
      source,
      required: options.required,
      requiredReason: options.required ? options.requiredReason ?? null : null,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function isCorePaperclipEntry(entry: PaperclipSkillEntry): boolean {
  const normalizedSource = entry.source.replaceAll("\\", "/");
  return (
    normalizedSource.endsWith("/@paperclipai/server/skills") ||
    normalizedSource.includes("/@paperclipai/server/skills/") ||
    normalizedSource.includes("/node_modules/paperclipai/node_modules/@paperclipai/server/skills/") ||
    entry.key.startsWith("paperclipai/paperclip/")
  );
}

function dedupeSkillEntries(entries: PaperclipSkillEntry[]): PaperclipSkillEntry[] {
  const byKey = new Map<string, PaperclipSkillEntry>();
  const seenRuntimeNames = new Set<string>();
  for (const entry of entries) {
    if (byKey.has(entry.key) || seenRuntimeNames.has(entry.runtimeName)) continue;
    byKey.set(entry.key, entry);
    seenRuntimeNames.add(entry.runtimeName);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export async function readHermesPaperclipSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string = __moduleDir,
  options: { companyId?: string | null } = {},
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = configuredRuntimeSkillEntries(config);
  const configuredCoreEntries = configuredEntries
    .filter(isCorePaperclipEntry)
    .map((entry) => ({
      ...entry,
      key: entry.key.startsWith("paperclipai/paperclip/")
        ? entry.key
        : `paperclipai/paperclip/${entry.runtimeName}`,
      required: true,
      requiredReason: entry.requiredReason ?? "Bundled Paperclip skills are always available for local adapters.",
    }));

  const configuredWorkspaceEntries = configuredEntries
    .filter((entry) => !isCorePaperclipEntry(entry))
    .map((entry) => ({
      ...entry,
      key: entry.key.startsWith("paperclipai/workspace/")
        ? entry.key
        : `paperclipai/workspace/${entry.runtimeName}`,
      required: false,
      requiredReason: null,
    }));

  const coreRoot = await resolveFirstExistingDirectory(
    coreSkillRootCandidates(config, moduleDir, options.companyId),
  );
  const workspaceRoot = await resolveFirstExistingDirectory(workspaceSkillRootCandidates(config));

  const discoveredCoreEntries = coreRoot
    ? await listFlatSkillEntries({
        root: coreRoot,
        keyPrefix: "paperclipai/paperclip",
        required: true,
        requiredReason: "Bundled Paperclip skills are always available for local adapters.",
      })
    : [];

  const discoveredWorkspaceEntries = workspaceRoot
    ? await listFlatSkillEntries({
        root: workspaceRoot,
        keyPrefix: "paperclipai/workspace",
        required: false,
      })
    : [];

  const allEntries = dedupeSkillEntries([
    ...discoveredCoreEntries,
    ...configuredCoreEntries,
    ...discoveredWorkspaceEntries,
    ...configuredWorkspaceEntries,
  ]);

  const syncRaw = config.paperclipSkillSync;
  if (typeof syncRaw === "object" && syncRaw !== null) {
    const desired = Array.isArray((syncRaw as any).desiredSkills) ? (syncRaw as any).desiredSkills : [];
    for (const entry of allEntries) {
      if (entry.key.startsWith("paperclipai/workspace/")) {
        const matchingDesired = desired.find((d: string) => d.endsWith("/" + entry.runtimeName));
        if (matchingDesired) {
          entry.key = matchingDesired;
        }
      }
    }
  }

  return allEntries;
}

async function resolvePaperclipHermesSkillName(runtimeName: string, source: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(source, "SKILL.md"), "utf8");
    const fm = parseSkillFrontmatter(content);
    return asString(fm.name) ?? runtimeName;
  } catch {
    return runtimeName;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(
  config: Record<string, unknown>,
  companyId?: string | null,
): Promise<AdapterSkillSnapshot> {
  const home = resolveHermesHome(config);
  const hermesSkillsHome = path.join(home, ".hermes", "skills");

  // 1. Scan Paperclip-managed skills: core Paperclip skills plus optional
  // workspace skills from the user's Paperclip workspace.
  const paperclipEntries = await readHermesPaperclipSkillEntries(config, __moduleDir, { companyId });
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    const hermesSkillName = await resolvePaperclipHermesSkillName(entry.runtimeName, entry.source);
    entries.push({
      key: entry.key,
      runtimeName: hermesSkillName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: entry.required ? "paperclip_required" : "company_managed",
      originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be materialized into the Paperclip-managed Hermes skill bundle on the next run."
        : null,
      required: Boolean(entry.required),
      requiredReason: entry.requiredReason ?? null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config, ctx.companyId);
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Hermes manages its own skill loading — sync is a no-op.
  // Return the current snapshot so the UI stays in sync.
  return buildHermesSkillSnapshot(ctx.config, ctx.companyId);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
