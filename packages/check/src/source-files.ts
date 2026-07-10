import type * as ts from "./typescript-api.js";

export interface SourceFileFilterOptions {
  readonly ignoreFilePatterns?: readonly string[];
}

const regexSpecialCharacters = new Set([
  "\\",
  "^",
  "$",
  "+",
  ".",
  "(",
  ")",
  "|",
  "{",
  "}",
  "[",
  "]",
]);

const escapeRegexCharacter = (character: string): string =>
  regexSpecialCharacters.has(character) ? `\\${character}` : character;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const normalizeIgnoreFilePattern = (pattern: string): string => {
  let normalized = normalizePath(pattern.trim());

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
};

export const normalizeIgnoreFilePatterns = (value: unknown): readonly string[] => {
  let patterns: readonly unknown[] = [];

  if (typeof value === "string") {
    patterns = [value];
  } else if (Array.isArray(value)) {
    patterns = value;
  }

  return patterns
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeIgnoreFilePattern(entry))
    .filter((entry) => entry.length > 0);
};

const globPatternToRegExp = (pattern: string): RegExp => {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      const isGlobStar = pattern[index + 1] === "*";

      if (isGlobStar) {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }

      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegexCharacter(character ?? "");
  }

  return new RegExp(`^${source}$`, "u");
};

const getPathSuffixes = (fileName: string): readonly string[] => {
  const normalized = normalizePath(fileName);
  const parts = normalized.split("/");
  const suffixes = parts.map((_part, index) => parts.slice(index).join("/"));

  return [...new Set([normalized, ...suffixes])];
};

const getBasename = (fileName: string): string => normalizePath(fileName).split("/").at(-1) ?? "";

const matchesIgnoreFilePattern = (fileName: string, pattern: string): boolean => {
  const normalizedPattern = normalizeIgnoreFilePattern(pattern);
  const patternRegExp = globPatternToRegExp(normalizedPattern);
  const candidates = normalizedPattern.includes("/")
    ? getPathSuffixes(fileName)
    : [getBasename(fileName)];

  return candidates.some((candidate) => patternRegExp.test(candidate));
};

export const isIgnoredFileName = (
  fileName: string,
  ignoreFilePatterns: readonly string[] | undefined,
): boolean =>
  normalizeIgnoreFilePatterns(ignoreFilePatterns).some((pattern) =>
    matchesIgnoreFilePattern(fileName, pattern),
  );

export const isExternalSourceFile = (sourceFile: ts.SourceFile): boolean =>
  sourceFile.isDeclarationFile ||
  sourceFile.fileName.includes("/node_modules/") ||
  sourceFile.fileName.includes("\\node_modules\\");

export const shouldInspectSourceFile = (
  sourceFile: ts.SourceFile,
  options: SourceFileFilterOptions = {},
): boolean =>
  !isExternalSourceFile(sourceFile) &&
  !isIgnoredFileName(sourceFile.fileName, options.ignoreFilePatterns);
