import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ResolvedCommand {
  readonly command: string;
  readonly baseArgs: readonly string[];
  readonly source: "configured" | "local-bin" | "pnpm" | "path";
}

export interface ResolveBinaryOptions {
  readonly workspaceRoot: string;
  readonly executablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly pathExists?: (candidate: string) => boolean;
}

const binNameForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "resultar-check.cmd" : "resultar-check";

export const resolveResultarCheckCommand = (options: ResolveBinaryOptions): ResolvedCommand => {
  const platform = options.platform ?? process.platform;
  const checkExists = options.pathExists ?? existsSync;
  const configured = options.executablePath?.trim() ?? "";

  if (configured.length > 0) {
    const resolvedPath = isAbsolute(configured)
      ? configured
      : resolve(options.workspaceRoot, configured);
    return { command: resolvedPath, baseArgs: [], source: "configured" };
  }

  const binName = binNameForPlatform(platform);
  let current = resolve(options.workspaceRoot);
  for (;;) {
    const candidate = join(current, "node_modules", ".bin", binName);
    if (checkExists(candidate)) {
      return { command: candidate, baseArgs: [], source: "local-bin" };
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (checkExists(join(options.workspaceRoot, "pnpm-lock.yaml"))) {
    return {
      command: platform === "win32" ? "pnpm.cmd" : "pnpm",
      baseArgs: ["exec", "resultar-check"],
      source: "pnpm",
    };
  }

  return { command: binName, baseArgs: [], source: "path" };
};
