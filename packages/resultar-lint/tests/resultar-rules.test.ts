import { deepEqual, equal, ok as isTrue } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vite-plus/test";

import type { ResultarRuleName } from "../src/finding.js";
import { findResultarLintFindings } from "../src/lint.js";
import { onlyResultarRule } from "../src/rules-core.js";
const tempDirs: string[] = [];

const createFixtureProject = async (source: string): Promise<string> => {
  const rootDir = await mkdtemp(join(tmpdir(), "resultar-rules-"));
  tempDirs.push(rootDir);

  await writeFile(
    join(rootDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ESNext",
      },
      include: ["fixture.ts"],
    }),
  );
  await writeFile(join(rootDir, "fixture.ts"), source);

  return rootDir;
};

const runRule = async (rule: ResultarRuleName, source: string) => {
  const rootDir = await createFixtureProject(source);
  const result = findResultarLintFindings({ rootDir, rules: onlyResultarRule(rule, "error") });

  if (!result.ok) {
    throw result.error;
  }

  return result.findings;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("Resultar lint rules", () => {
  it("flags orElse callbacks that only return Err", async () => {
    const findings = await runRule(
      "prefer-map-err",
      `
        type Result<T, E> = {
          orElse<X, Y>(fn: (error: E) => Result<X, Y>): Result<T | X, Y>
        }
        declare function err<T = never, E = unknown>(error: E): Result<T, E>
        declare const result: Result<string, Error>

        result.orElse((error) => err(new TypeError(error.message)))
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "prefer-map-err");
  });

  it("allows orElse callbacks that recover to Ok or non-Result receivers", async () => {
    const recoverFindings = await runRule(
      "prefer-map-err",
      `
        type Result<T, E> = {
          orElse<X, Y>(fn: (error: E) => Result<X, Y>): Result<T | X, Y>
        }
        declare function ok<T, E = never>(value: T): Result<T, E>
        declare const result: Result<string, Error>

        result.orElse(() => ok("recovered"))
      `,
    );
    const nonCallReturnFindings = await runRule(
      "prefer-map-err",
      `
        type Result<T, E> = {
          orElse<X, Y>(fn: (error: E) => Result<X, Y> | string): Result<T | X, Y>
        }
        declare const result: Result<string, Error>

        result.orElse(() => "fallback")
      `,
    );
    const nonResultFindings = await runRule(
      "prefer-map-err",
      `
        declare const result: { orElse(fn: () => unknown): unknown }
        declare function err(error: Error): unknown

        result.orElse(() => err(new Error("not a Result receiver")))
      `,
    );

    deepEqual(recoverFindings, []);
    deepEqual(nonCallReturnFindings, []);
    deepEqual(nonResultFindings, []);
  });

  it("flags map callbacks that return Resultar values", async () => {
    const findings = await runRule(
      "prefer-and-then",
      `
        type Result<T, E> = {
          map<X>(fn: (value: T) => X): Result<X, E>
        }
        declare function ok<T, E = never>(value: T): Result<T, E>
        declare const result: Result<string, Error>

        result.map((value) => ok(value.length))
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "prefer-and-then");
    isTrue(findings[0]?.message.includes("Use `andThen`"));
  });

  it("recommends asyncAndThen when map returns ResultAsync", async () => {
    const findings = await runRule(
      "prefer-and-then",
      `
        type Result<T, E> = {
          map<X>(fn: (value: T) => X): Result<X, E>
        }
        class ResultAsync<T, E> {
          readonly value?: T
          readonly error?: E
        }
        declare function loadUser(value: string): ResultAsync<number, Error>
        declare const result: Result<string, Error>

        result.map((value) => loadUser(value))
      `,
    );

    equal(findings.length, 1);
    isTrue(findings[0]?.message.includes("Use `asyncAndThen`"));
  });

  it("allows map callbacks that return plain values or use non-Result receivers", async () => {
    const plainValueFindings = await runRule(
      "prefer-and-then",
      `
        type Result<T, E> = {
          map<X>(fn: (value: T) => X): Result<X, E>
        }
        declare const result: Result<string, Error>

        result.map((value) => value.length)
      `,
    );
    const nonResultFindings = await runRule(
      "prefer-and-then",
      `
        declare const values: string[]

        values.map((value) => value.length)
      `,
    );

    deepEqual(plainValueFindings, []);
    deepEqual(nonResultFindings, []);
  });

  it("flags catch conversion helpers without typed mappers", async () => {
    const findings = await runRule(
      "typed-catch-mapper",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare function tryResult<T>(fn: () => T): Result<T, unknown>

        tryResult(() => JSON.parse("{}"))
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "typed-catch-mapper");
  });

  it("allows catch conversion helpers with typed return errors or object catch mappers", async () => {
    const typedReturnFindings = await runRule(
      "typed-catch-mapper",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare function tryResult<T, E>(fn: () => T): Result<T, E>

        tryResult<string, TypeError>(() => JSON.parse("{}"))
      `,
    );

    const objectMapperFindings = await runRule(
      "typed-catch-mapper",
      `
        declare function tryResult(options: unknown): unknown

        tryResult({
          try: () => JSON.parse("{}"),
          catch: (error: unknown) => new TypeError(String(error))
        })
      `,
    );
    const spreadPropertyFindings = await runRule(
      "typed-catch-mapper",
      `
        declare function tryResult<T>(options: unknown): { readonly value?: T; readonly error?: unknown }
        declare const mapper: { readonly catch: (error: unknown) => Error }

        tryResult({
          try: () => JSON.parse("{}"),
          ...mapper
        })
      `,
    );

    deepEqual(typedReturnFindings, []);
    deepEqual(objectMapperFindings, []);
    equal(spreadPropertyFindings.length, 1);
  });

  it("flags try/catch inside safeTry generators", async () => {
    const findings = await runRule(
      "no-try-catch-in-safe-try",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare function safeTry<T, E>(fn: () => Generator<Result<never, E>, T>): Result<T, E>

        safeTry(function* () {
          try {
            return 1
          } catch {
            return 2
          }
        })
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "no-try-catch-in-safe-try");
  });

  it("flags try/catch inside safeTry object methods", async () => {
    const findings = await runRule(
      "no-try-catch-in-safe-try",
      `
        declare function safeTry(value: unknown): unknown

        safeTry({
          try() {
            try {
              return 1
            } catch {
              return 2
            }
          },
          catch: () => 2
        })
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "no-try-catch-in-safe-try");
  });

  it("ignores safeTry calls without an inspectable Resultar body", async () => {
    const findings = await runRule(
      "no-try-catch-in-safe-try",
      `
        declare function safeTry(value?: unknown): unknown

        safeTry()
        safeTry(1)
        safeTry({ catch: () => 1 })
        safeTry(function* () {
          function nested() {
            try {
              return 1
            } catch {
              return 2
            }
          }

          return nested()
        })
      `,
    );

    deepEqual(findings, []);
  });

  it("flags yield without star for Resultar values inside safeTry", async () => {
    const findings = await runRule(
      "yield-star-in-safe-try",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare function safeTry<T, E>(fn: () => Generator<Result<never, E>, T>): Result<T, E>
        declare function parse(): Result<string, Error>

        safeTry(function* () {
          const value = yield parse()
          return value
        })
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "yield-star-in-safe-try");
  });

  it("flags yield without star inside safeTry object property functions", async () => {
    const findings = await runRule(
      "yield-star-in-safe-try",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare function safeTry(value: unknown): unknown
        declare function parse(): Result<string, Error>

        safeTry({
          try: function* () {
            const value = yield parse()
            return value
          },
          catch: () => "fallback"
        })
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "yield-star-in-safe-try");
  });

  it("flags assertions that narrow Resultar error channels", async () => {
    const findings = await runRule(
      "unsafe-result-type-assertion",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        class FirstError extends Error { readonly first = true }
        class SecondError extends Error { readonly second = true }
        declare const result: Result<string, FirstError | SecondError>

        const narrowed = result as Result<string, FirstError>
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "unsafe-result-type-assertion");
  });

  it("allows assertions that keep or do not involve Resultar error channels", async () => {
    const findings = await runRule(
      "unsafe-result-type-assertion",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare const result: Result<string, Error>
        declare const value: unknown

        const sameError = result as Result<string, Error>
        const plain = value as string
      `,
    );

    deepEqual(findings, []);
  });

  it("flags native Error subclasses", async () => {
    const findings = await runRule(
      "prefer-tagged-error",
      `
        class DomainError extends Error {}
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "prefer-tagged-error");
  });

  it("flags native Error instances passed to err", async () => {
    const findings = await runRule(
      "prefer-tagged-error",
      `
        type Result<T, E> = { readonly value?: T; readonly error?: E }
        declare function err<T = never, E = unknown>(error: E): Result<T, E>

        err(new Error("boom"))
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "prefer-tagged-error");
  });

  it("allows err calls without a native Error instance", async () => {
    const findings = await runRule(
      "prefer-tagged-error",
      `
        declare function err(error?: unknown): unknown

        err()
        err(new TypeError("not the base Error constructor"))
      `,
    );

    deepEqual(findings, []);
  });

  it("flags tagged error names that do not match the class name", async () => {
    const findings = await runRule(
      "tagged-error-name-match",
      `
        declare function createTaggedError(
          options: { readonly message?: string; readonly name: string }
        ): new (...args: readonly unknown[]) => Error

        class InvalidEmailError extends createTaggedError({
          name: "OtherEmailError",
          message: "Invalid email"
        }) {}
      `,
    );

    equal(findings.length, 1);
    deepEqual(
      findings.map((finding) => finding.rule),
      ["tagged-error-name-match"],
    );
  });

  it("allows tagged errors without names or with matching template names", async () => {
    const findings = await runRule(
      "tagged-error-name-match",
      `
        declare function createTaggedError(
          options: { readonly message?: string; readonly name?: string }
        ): new (...args: readonly unknown[]) => Error

        class MissingNameError extends createTaggedError({
          message: "No name to compare"
        }) {}

        class TemplateNameError extends createTaggedError({
          name: \`TemplateNameError\`,
          message: "Template literal names are allowed"
        }) {}
      `,
    );

    deepEqual(findings, []);
  });

  it("flags constructor overrides on createTaggedError classes", async () => {
    const findings = await runRule(
      "no-tagged-error-constructor-override",
      `
        declare function createTaggedError(
          options: { readonly message?: string; readonly name: string }
        ): new (...args: readonly unknown[]) => Error

        class InvalidEmailError extends createTaggedError({
          name: "InvalidEmailError",
          message: "Invalid email"
        }) {
          constructor() {
            super()
          }
        }
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "no-tagged-error-constructor-override");
  });

  it("flags recovery methods on infallible Resultar values", async () => {
    const findings = await runRule(
      "no-useless-recovery",
      `
        type Result<T, E> = {
          mapErr<X>(fn: (error: E) => X): Result<T, X>
        }
        declare const result: Result<string, never>

        result.mapErr((error) => error)
      `,
    );

    equal(findings.length, 1);
    equal(findings[0]?.rule, "no-useless-recovery");
  });

  it("allows recovery methods on fallible Resultar values", async () => {
    const findings = await runRule(
      "no-useless-recovery",
      `
        type Result<T, E> = {
          catchTag(tag: string, fn: (error: E) => T): Result<T, E>
          mapErr<X>(fn: (error: E) => X): Result<T, X>
        }
        declare const result: Result<string, Error>

        result.mapErr((error) => error)
        result.catchTag("DomainError", () => "fallback")
      `,
    );

    deepEqual(findings, []);
  });

  it("honors disabled no-discard and custom rule severities", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly value?: T; readonly error?: E }
      declare function saveUser(): Result<string, Error>
      declare function err<T = never, E = unknown>(error: E): Result<T, E>

      saveUser()
      err(new Error("boom"))
    `);
    const result = findResultarLintFindings({
      rootDir,
      rules: onlyResultarRule("prefer-tagged-error", "suggestion"),
    });

    if (!result.ok) {
      throw result.error;
    }

    equal(result.findings.length, 1);
    equal(result.findings[0]?.rule, "prefer-tagged-error");
    equal(result.findings[0]?.severity, "suggestion");
  });
});
