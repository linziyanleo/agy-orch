import fs from "node:fs";
import path from "node:path";
import {
  BUNDLED_BACKENDS_DIR,
  ensureDir,
  getUserBackendsDir,
  getUserConfigPath,
} from "./paths.ts";
import type {
  BackendProfile,
  DiscoveredBackend,
  ProjectConfig,
  ResolvedConfig,
  RoleConfig,
  UserConfig,
} from "./types.ts";

export const DEFAULT_ROLES: Record<string, RoleConfig> = {
  lead: {
    agent: "agy",
    backend: "agy",
  },
  reviewer: {
    backend: "codex",
    max_rounds: 2,
    timeout_sec: 600,
  },
  implementer: {
    backend: "codex",
    timeout_sec: 900,
  },
};

export const DEFAULT_USER_CONFIG: UserConfig = {
  roles: DEFAULT_ROLES,
  defaults: {
    timeout_sec: 900,
    max_rounds: 2,
  },
};

const ALLOWED_PROJECT_ROLE_KEYS = new Set([
  "agent",
  "backend",
  "model",
  "effort",
  "max_rounds",
  "timeout_sec",
]);

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveBinary(binary: string): string | null {
  if (!binary) return null;
  if (path.isAbsolute(binary) || binary.includes(path.sep)) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // continue scanning PATH
    }
  }
  return null;
}

function loadBackendProfilesFromDir(
  dirPath: string,
  source: "bundled" | "user",
  map: Map<string, DiscoveredBackend>
): void {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dirPath, entry.name);
    const parsed = readJsonFile(filePath) as BackendProfile;
    if (!parsed || typeof parsed.name !== "string" || typeof parsed.binary !== "string") {
      continue;
    }
    const resolvedBinary = resolveBinary(parsed.binary);
    map.set(parsed.name, {
      name: parsed.name,
      display_name: parsed.display_name || parsed.name,
      active: Boolean(parsed.active),
      binary: parsed.binary,
      resolved_binary: resolvedBinary,
      available: resolvedBinary !== null,
      source,
      profile_path: filePath,
      capabilities: parsed.capabilities,
      profile: parsed,
    });
  }
}

export function discoverBackends(): DiscoveredBackend[] {
  const map = new Map<string, DiscoveredBackend>();
  loadBackendProfilesFromDir(BUNDLED_BACKENDS_DIR, "bundled", map);
  loadBackendProfilesFromDir(getUserBackendsDir(), "user", map);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getBackend(name: string): DiscoveredBackend | null {
  return discoverBackends().find((b) => b.name === name) ?? null;
}

export function initUserConfig(): {
  path: string;
  created: boolean;
  status: "created" | "already_exists";
} {
  const configPath = getUserConfigPath();
  if (fs.existsSync(configPath)) {
    return { path: configPath, created: false, status: "already_exists" };
  }
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_USER_CONFIG, null, 2)}\n`, "utf8");
  return { path: configPath, created: true, status: "created" };
}

function sanitizeProjectConfig(
  raw: unknown
): { sanitized: ProjectConfig; ignoredKeys: string[] } {
  const ignoredKeys: string[] = [];
  if (!isPlainObject(raw)) {
    return { sanitized: {}, ignoredKeys };
  }
  const sanitized: ProjectConfig = {};
  for (const key of Object.keys(raw)) {
    if (key === "roles" && isPlainObject(raw.roles)) {
      const roles: Record<string, Partial<RoleConfig>> = {};
      for (const [roleName, roleVal] of Object.entries(raw.roles)) {
        if (!isPlainObject(roleVal)) continue;
        const cleanRole: Record<string, unknown> = {};
        for (const [rk, rv] of Object.entries(roleVal)) {
          if (ALLOWED_PROJECT_ROLE_KEYS.has(rk)) {
            cleanRole[rk] = rv;
          } else {
            ignoredKeys.push(`roles.${roleName}.${rk}`);
          }
        }
        roles[roleName] = cleanRole as Partial<RoleConfig>;
      }
      sanitized.roles = roles;
    } else if (key === "defaults" && isPlainObject(raw.defaults)) {
      const defs: ProjectConfig["defaults"] = {};
      for (const [dk, dv] of Object.entries(raw.defaults)) {
        if (dk === "timeout_sec" && typeof dv === "number") {
          defs.timeout_sec = dv;
        } else if (dk === "max_rounds" && typeof dv === "number") {
          defs.max_rounds = dv;
        } else if (dk === "scope" && isPlainObject(dv)) {
          defs.scope = dv as ProjectConfig["defaults"] extends infer D
            ? D extends { scope?: infer S }
              ? S
              : never
            : never;
        } else {
          ignoredKeys.push(`defaults.${dk}`);
        }
      }
      sanitized.defaults = defs;
    } else {
      // Untrusted keys such as `backends`, `binary`, `commands`, etc. are never honored from project config.
      ignoredKeys.push(key);
    }
  }
  return { sanitized, ignoredKeys };
}

function mergeRoleLayer(base: RoleConfig, override: Partial<RoleConfig>): RoleConfig {
  const prevBackend = base.backend;
  const nextBackend = override.backend ?? prevBackend;
  const switchedBackend = Boolean(override.backend && prevBackend && override.backend !== prevBackend);
  const carried = switchedBackend ? { ...base, model: undefined, effort: undefined } : base;
  return {
    ...carried,
    ...override,
    backend: nextBackend,
  };
}

export function loadMergedConfig(cwd?: string): ResolvedConfig {
  const userConfigPath = getUserConfigPath();
  const userExists = fs.existsSync(userConfigPath);
  const userCfg: UserConfig = userExists ? (readJsonFile(userConfigPath) as UserConfig) : {};

  const projectConfigPath = cwd ? path.join(cwd, ".agy-orch", "config.json") : null;
  const projectExists = Boolean(projectConfigPath && fs.existsSync(projectConfigPath));
  const rawProject = projectExists && projectConfigPath ? readJsonFile(projectConfigPath) : null;
  const { sanitized: projectCfg, ignoredKeys } = sanitizeProjectConfig(rawProject);

  const roles: Record<string, RoleConfig> = {};
  const allRoleNames = new Set([
    ...Object.keys(DEFAULT_ROLES),
    ...Object.keys(userCfg.roles ?? {}),
    ...Object.keys(projectCfg.roles ?? {}),
  ]);

  for (const roleName of allRoleNames) {
    const base = DEFAULT_ROLES[roleName] ?? { backend: "codex" };
    const userRole = userCfg.roles?.[roleName] ?? {};
    const projRole = projectCfg.roles?.[roleName] ?? {};
    roles[roleName] = mergeRoleLayer(mergeRoleLayer(base, userRole), projRole);
  }

  const defaults = {
    timeout_sec:
      projectCfg.defaults?.timeout_sec ??
      userCfg.defaults?.timeout_sec ??
      DEFAULT_USER_CONFIG.defaults!.timeout_sec!,
    max_rounds:
      projectCfg.defaults?.max_rounds ??
      userCfg.defaults?.max_rounds ??
      DEFAULT_USER_CONFIG.defaults!.max_rounds!,
  };

  return {
    roles,
    defaults,
    sources: {
      user_config_path: userConfigPath,
      user_config_exists: userExists,
      project_config_path: projectConfigPath,
      project_config_exists: projectExists,
      ignored_untrusted_project_keys: ignoredKeys,
    },
  };
}

export interface ResolveRunInput {
  cwd?: string;
  role: string;
  backend?: string;
  model?: string;
  effort?: string;
  timeout_sec?: number;
  max_rounds?: number;
}

export interface ResolvedRunSettings {
  role: string;
  backend: string;
  model: string | null;
  effort: string | null;
  timeout_sec: number;
  max_rounds: number;
  backend_profile: DiscoveredBackend | null;
  config_sources: ResolvedConfig["sources"];
}

export function resolveRunSettings(input: ResolveRunInput): ResolvedRunSettings {
  const merged = loadMergedConfig(input.cwd);
  const roleCfg = merged.roles[input.role] ?? DEFAULT_ROLES.reviewer;

  const envBackend = process.env.AGY_ORCH_BACKEND?.trim() || undefined;
  const envModel = process.env.AGY_ORCH_MODEL?.trim() || undefined;
  const envEffort = process.env.AGY_ORCH_EFFORT?.trim() || undefined;
  const envTimeoutRaw = process.env.AGY_ORCH_TIMEOUT_SEC?.trim();
  const envTimeout =
    envTimeoutRaw && Number.isFinite(Number(envTimeoutRaw)) && Number(envTimeoutRaw) > 0
      ? Number(envTimeoutRaw)
      : undefined;

  const roleBackend = roleCfg.backend ?? "codex";
  const backendName = input.backend ?? envBackend ?? roleBackend;
  const backendRole = backendName === roleBackend ? roleCfg : undefined;
  const backendDiscovered = getBackend(backendName);
  const backendDefaults = backendDiscovered?.profile.defaults;

  const model = input.model ?? envModel ?? backendRole?.model ?? backendDefaults?.model ?? null;
  const effort = input.effort ?? envEffort ?? backendRole?.effort ?? backendDefaults?.effort ?? null;
  const timeout_sec =
    input.timeout_sec ??
    envTimeout ??
    roleCfg.timeout_sec ??
    backendDefaults?.timeout_sec ??
    merged.defaults.timeout_sec;
  const max_rounds = input.max_rounds ?? roleCfg.max_rounds ?? merged.defaults.max_rounds;

  return {
    role: input.role,
    backend: backendName,
    model,
    effort,
    timeout_sec,
    max_rounds,
    backend_profile: backendDiscovered,
    config_sources: merged.sources,
  };
}
