/**
 * Lightweight, zero-dependency TypeScript-to-JavaScript transformer for the Resultar browser
 * playground. Preserves strings, template literals, and comments verbatim while rewriting
 * `resultar` imports to the live injected runtime module and stripping TypeScript-only syntax.
 */

interface MaskResult {
  readonly code: string;
  readonly tokens: readonly string[];
}

const maskStringsAndComments = (source: string): MaskResult => {
  const tokens: string[] = [];
  let out = "";
  let i = 0;

  const pushToken = (raw: string): void => {
    const id = tokens.length;
    tokens.push(raw);
    out += `\u0001T${id}\u0001`;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      pushToken(source.slice(start, i));
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i++;
      }
      i = Math.min(source.length, i + 2);
      pushToken(source.slice(start, i));
      continue;
    }

    // Single or double quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      pushToken(source.slice(start, i));
      continue;
    }

    // Template literal (preserve expressions inside ${...})
    if (ch === "`") {
      const start = i;
      i++;
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}") depth--;
          i++;
          continue;
        }
        if (source[i] === "`") {
          i++;
          break;
        }
        i++;
      }
      pushToken(source.slice(start, i));
      continue;
    }

    out += ch;
    i++;
  }

  return { code: out, tokens };
};

const unmask = (code: string, tokens: readonly string[]): string =>
  code.replaceAll(/\u0001T(\d+)\u0001/g, (_match, idx) => tokens[Number(idx)] ?? "");

const findMatchingDelimiter = (
  code: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number => {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const stripInterfaces = (code: string): string => {
  let result = "";
  let i = 0;
  const pattern = /(?:^|\n)[ \t]*(?:export[ \t]+)?interface[ \t]+[A-Za-z_$][\w$]*/g;

  for (;;) {
    pattern.lastIndex = i;
    const match = pattern.exec(code);
    if (!match) {
      result += code.slice(i);
      break;
    }
    const start = match.index;
    result += code.slice(i, start);
    const braceIndex = code.indexOf("{", pattern.lastIndex);
    if (braceIndex === -1) {
      result += code.slice(start);
      break;
    }
    const endBrace = findMatchingDelimiter(code, braceIndex, "{", "}");
    if (endBrace === -1) {
      result += code.slice(start);
      break;
    }
    result += "\n";
    i = endBrace + 1;
  }
  return result;
};

const stripTypeAliases = (code: string): string => {
  let result = "";
  let i = 0;
  const pattern = /(?:^|\n)[ \t]*(?:export[ \t]+)?type[ \t]+[A-Za-z_$][\w$]*(?:<[^>\n]*>)?[ \t]*=/g;

  for (;;) {
    pattern.lastIndex = i;
    const match = pattern.exec(code);
    if (!match) {
      result += code.slice(i);
      break;
    }
    const start = match.index;
    result += code.slice(i, start);
    let pos = pattern.lastIndex;
    let braceDepth = 0;
    let parenDepth = 0;
    let angleDepth = 0;
    let bracketDepth = 0;

    while (pos < code.length) {
      const ch = code[pos];
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "<") angleDepth++;
      else if (ch === ">" && code[pos - 1] !== "=") angleDepth = Math.max(0, angleDepth - 1);
      else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
        if (ch === ";") {
          pos++;
          break;
        }
        if (ch === "\n") {
          const rest = code.slice(pos + 1);
          if (!/^[ \t]*(?:\||&|\?|:)/.test(rest)) {
            break;
          }
        }
      }
      pos++;
    }
    result += "\n";
    i = pos;
  }
  return result;
};

const rewriteImports = (code: string, tokens: readonly string[]): string => {
  // Remove `import type ...` statements completely.
  let out = code.replaceAll(
    /(?:^|\n)[ \t]*import[ \t]+type[ \t]+[\s\S]*?from[ \t]+\u0001T\d+\u0001[ \t]*;?/g,
    "\n",
  );

  // Rewrite `import * as X from "resultar..."`
  out = out.replaceAll(
    /(?:^|\n)[ \t]*import[ \t]+\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)[ \t]+from[ \t]+\u0001T(\d+)\u0001[ \t]*;?/g,
    (_m, alias: string, tokIdx: string) => {
      const specifier = (tokens[Number(tokIdx)] ?? "").slice(1, -1);
      if (specifier === "resultar" || specifier.startsWith("resultar/")) {
        return `\nconst ${alias} = __resultar;`;
      }
      throw new Error(`Playground only supports imports from "resultar" (found "${specifier}").`);
    },
  );

  // Rewrite `import { a, type B, c as d } from "resultar..."`
  out = out.replaceAll(
    /(?:^|\n)[ \t]*import[ \t]+\{([\s\S]*?)\}[ \t]+from[ \t]+\u0001T(\d+)\u0001[ \t]*;?/g,
    (_m, specList: string, tokIdx: string) => {
      const specifier = (tokens[Number(tokIdx)] ?? "").slice(1, -1);
      if (specifier !== "resultar" && !specifier.startsWith("resultar/")) {
        throw new Error(`Playground only supports imports from "resultar" (found "${specifier}").`);
      }
      const bindings = specList
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !part.startsWith("type "))
        .map((part) => {
          const asMatch = /^([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(part);
          if (asMatch) {
            return `${asMatch[1]}: ${asMatch[2]}`;
          }
          return part;
        });
      if (bindings.length === 0) return "\n";
      return `\nconst { ${bindings.join(", ")} } = __resultar;`;
    },
  );

  // Strip export keywords.
  out = out.replaceAll(/(?:^|\n)([ \t]*)export[ \t]+default[ \t]+/g, "\n$1");
  out = out.replaceAll(
    /(?:^|\n)([ \t]*)export[ \t]+(?=(?:const|let|var|async|function|class)\b)/g,
    "\n$1",
  );
  return out;
};

const stripBalancedCallGenerics = (code: string): string => {
  // Strip `<TypeArgs>(` after identifiers such as `withProps<{ id: string }>()`,
  // `Deferred.make<string>()`, `Queue.bounded<number>(2)`, `Retry.policy<Err>({ ... })`,
  // `new Map<string, number>()`, `function foo<T>(...)`, etc.
  let result = "";
  let i = 0;

  while (i < code.length) {
    if (code[i] === "<" && i > 0 && /[A-Za-z0-9_$]/.test(code[i - 1] ?? "")) {
      // Ensure it is not `<=` or `<<` or preceded by a space (comparison).
      const next = code[i + 1];
      if (next !== "=" && next !== "<" && next !== " ") {
        const end = findMatchingAngleForTypeArgs(code, i);
        if (end !== -1) {
          let after = end + 1;
          while (after < code.length && (code[after] === " " || code[after] === "\t")) {
            after++;
          }
          if (code[after] === "(") {
            i = end + 1;
            continue;
          }
        }
      }
    }
    result += code[i];
    i++;
  }
  return result;
};

const findMatchingAngleForTypeArgs = (code: string, start: number): number => {
  let angleDepth = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      if (braceDepth === 0) return -1;
      braceDepth--;
    } else if (ch === "(") parenDepth++;
    else if (ch === ")") {
      if (parenDepth === 0) return -1;
      parenDepth--;
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") {
      if (bracketDepth === 0) return -1;
      bracketDepth--;
    } else if (ch === "<") {
      angleDepth++;
    } else if (ch === ">") {
      if (code[i - 1] === "=") {
        // `=>` inside a function type `(x: number) => void`
        continue;
      }
      angleDepth--;
      if (angleDepth === 0) {
        return braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 ? i : -1;
      }
    } else if (ch === ";" && braceDepth === 0) {
      return -1;
    }
  }
  return -1;
};

const stripParamListTypes = (paramsRaw: string): string => {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let angle = 0;

  for (let i = 0; i < paramsRaw.length; i++) {
    const ch = paramsRaw[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "<") angle++;
    else if (ch === ">" && paramsRaw[i - 1] !== "=") angle = Math.max(0, angle - 1);

    if (ch === "," && depth === 0 && angle === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current);

  const cleaned = parts.map((rawPart) => {
    const part = rawPart.trim();
    if (part.length === 0) return "";
    // Find top-level `:` (type annotation) and `=` (default value).
    let d = 0;
    let a = 0;
    let colonIdx = -1;
    let eqIdx = -1;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (ch === "(" || ch === "{" || ch === "[") d++;
      else if (ch === ")" || ch === "}" || ch === "]") d = Math.max(0, d - 1);
      else if (ch === "<") a++;
      else if (ch === ">" && part[i - 1] !== "=") a = Math.max(0, a - 1);
      else if (d === 0 && a === 0) {
        if (ch === ":" && colonIdx === -1 && eqIdx === -1) {
          colonIdx = i;
        } else if (
          ch === "=" &&
          part[i + 1] !== ">" &&
          part[i + 1] !== "=" &&
          part[i - 1] !== "="
        ) {
          eqIdx = i;
          break;
        }
      }
    }
    if (colonIdx === -1) {
      return part.replace(/^([A-Za-z_$][\w$]*)\?(?=\s|$|=)/, "$1");
    }
    const lhs = part.slice(0, colonIdx).trim().replace(/\?$/, "");
    if (eqIdx !== -1) {
      return `${lhs} ${part.slice(eqIdx).trim()}`;
    }
    return lhs;
  });

  return cleaned.join(", ");
};

const stripFunctionSignatures = (code: string): string => {
  // Clean parameter lists & return types on arrow functions and `function` declarations.
  let out = "";
  let i = 0;

  while (i < code.length) {
    // Detect `function ...(...)` or arrow `(...)` followed by `: ReturnType =>` or `=>` or `: ReturnType {`
    if (code[i] === "(") {
      const closeIdx = findMatchingDelimiter(code, i, "(", ")");
      if (closeIdx !== -1) {
        const afterParen = code.slice(closeIdx + 1);
        const isArrowDirect = /^[ \t]*=>/.test(afterParen);
        const typedReturnArrow = /^[ \t]*:([\s\S]*?)=>/.exec(afterParen);
        const beforeParen = code.slice(Math.max(0, i - 40), i);
        const isFunctionHeader = /\bfunction\*?(?:[ \t]+[A-Za-z_$][\w$]*)?[ \t]*$/.test(
          beforeParen,
        );

        if (isFunctionHeader) {
          const inner = stripParamListTypes(code.slice(i + 1, closeIdx));
          out += `(${inner})`;
          const after = closeIdx + 1;
          const wsMatch = /^[ \t]*/.exec(code.slice(after));
          const colonPos = after + (wsMatch?.[0].length ?? 0);
          if (code[colonPos] === ":") {
            // Skip return type until `{`
            const bodyBrace = findReturnTypeEnd(code, colonPos + 1, "{");
            if (bodyBrace !== -1) {
              out += " ";
              i = bodyBrace;
              continue;
            }
          }
          i = closeIdx + 1;
          continue;
        }

        if (isArrowDirect) {
          const inner = stripParamListTypes(code.slice(i + 1, closeIdx));
          out += `(${inner})`;
          i = closeIdx + 1;
          continue;
        }

        if (
          typedReturnArrow !== null &&
          typedReturnArrow[1] !== undefined &&
          !typedReturnArrow[1].includes(";")
        ) {
          const arrowEnd = findReturnTypeEnd(
            code,
            closeIdx + 1 + afterParen.indexOf(":") + 1,
            "=>",
          );
          if (arrowEnd !== -1) {
            const inner = stripParamListTypes(code.slice(i + 1, closeIdx));
            out += `(${inner}) `;
            i = arrowEnd;
            continue;
          }
        }
      }
    }
    out += code[i];
    i++;
  }
  return out;
};

const findReturnTypeEnd = (code: string, start: number, sentinel: "{" | "=>"): number => {
  let braceDepth = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;

  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (braceDepth === 0 && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0) {
      if (sentinel === "{" && ch === "{") {
        // Distinguish object return type `{ readonly x: number } {` vs function body `{`
        const matching = findMatchingDelimiter(code, i, "{", "}");
        if (matching !== -1) {
          const afterClose = code.slice(matching + 1).trimStart();
          if (
            afterClose.startsWith("{") ||
            afterClose.startsWith("|") ||
            afterClose.startsWith("&")
          ) {
            braceDepth++;
            continue;
          }
        }
        return i;
      }
      if (sentinel === "=>" && ch === "=" && code[i + 1] === ">") {
        return i;
      }
      if (ch === ";") return -1;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "<") angleDepth++;
    else if (ch === ">" && code[i - 1] !== "=") angleDepth = Math.max(0, angleDepth - 1);
  }
  return -1;
};

const stripVariableAnnotations = (code: string): string => {
  let result = "";
  let i = 0;
  const pattern = /\b(const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*:/g;

  for (;;) {
    pattern.lastIndex = i;
    const match = pattern.exec(code);
    if (!match) {
      result += code.slice(i);
      break;
    }
    result += code.slice(i, match.index);
    result += `${match[1]} ${match[2]}`;
    let pos = pattern.lastIndex;
    let brace = 0;
    let paren = 0;
    let bracket = 0;
    let angle = 0;

    while (pos < code.length) {
      const ch = code[pos];
      if (ch === "{") brace++;
      else if (ch === "}") brace = Math.max(0, brace - 1);
      else if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (ch === "[") bracket++;
      else if (ch === "]") bracket = Math.max(0, bracket - 1);
      else if (ch === "<") angle++;
      else if (ch === ">" && code[pos - 1] !== "=") angle = Math.max(0, angle - 1);
      else if (brace === 0 && paren === 0 && bracket === 0 && angle === 0) {
        if (ch === "=" && code[pos + 1] !== ">") {
          result += " ";
          break;
        }
        if (ch === ";" || ch === "\n") {
          break;
        }
      }
      pos++;
    }
    i = pos;
  }
  return result;
};

const stripAsAndSatisfies = (code: string): string =>
  code
    .replaceAll(/\bas[ \t]+const\b/g, "")
    .replaceAll(
      /\b(?:as|satisfies)[ \t]+(?:readonly[ \t]+)?[A-Za-z_$][\w$<>[\]|& ,.]*(?=[ \t]*[;,)\]\n}])/g,
      "",
    );

export const transpilePlaygroundTs = (source: string): string => {
  const { code: masked, tokens } = maskStringsAndComments(source);
  let code = rewriteImports(masked, tokens);
  code = stripInterfaces(code);
  code = stripTypeAliases(code);
  code = stripBalancedCallGenerics(code);
  code = stripFunctionSignatures(code);
  code = stripVariableAnnotations(code);
  code = stripAsAndSatisfies(code);
  return unmask(code, tokens);
};
