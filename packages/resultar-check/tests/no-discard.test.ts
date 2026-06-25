import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deepEqual, equal, ok as isTrue } from "node:assert";
import { afterEach, describe, it } from "vite-plus/test";

import { findDiscardedResults } from "../src/lint.js";

const tempDirs: string[] = [];

const createFixtureProject = async (
  source: string,
  compilerOptions: Record<string, unknown> = {},
): Promise<string> => {
  const rootDir = await mkdtemp(join(tmpdir(), "resultar-check-"));
  tempDirs.push(rootDir);

  await writeFile(
    join(rootDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        ...compilerOptions,
        strict: true,
        target: "ESNext",
      },
      include: ["fixture.ts"],
    }),
  );
  await writeFile(join(rootDir, "fixture.ts"), source);

  return rootDir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("no-discard Result check", () => {
  it("flags ignored Result and ResultAsync expressions", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      class ResultAsync<T, E> {
        constructor(readonly result: Result<T, E>) {}
      }
      declare function saveUser(input: string): Result<string, Error>
      declare function saveUserAsync(input: string): ResultAsync<string, Error>

      saveUser('a')
      saveUserAsync('b')
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    const { findings } = result;
    deepEqual(
      findings.map((finding) => finding.line),
      [9, 10],
    );
    equal(findings[0]?.type, "Result<string, Error>");
    equal(findings[1]?.type, "ResultAsync<string, Error>");
  });

  it("allows explicit void discards and handled results", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>

      const result = saveUser('a')
      void saveUser('b')
      result.value
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("allows assigned Result values in direct mode", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>
      declare function externalFunction(value: unknown): void

      const result = saveUser('a')
      externalFunction(result)
    `);

    const result = findDiscardedResults({ mode: "direct", rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("flags direct Resultar discards inside await, conditional, and logical expressions", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>

      async function run(flag: boolean, fallback: boolean | null) {
        await saveUser('awaited')
        flag ? saveUser('true') : saveUser('false')
        flag && saveUser('and')
        flag || saveUser('or')
        fallback ?? saveUser('nullish')
      }
    `);

    const result = findDiscardedResults({ mode: "direct", rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(
      result.findings.map((finding) => finding.line),
      [6, 7, 8, 9, 10],
    );
    equal(
      result.findings.every((finding) => finding.message.startsWith("Ignored ")),
      true,
    );
  });

  it("flags assigned Result values that are not handled by default", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = {
        readonly error?: E
        readonly value?: T
        match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B
        unwrapOr(defaultValue: T): T
        isErr(): boolean
      }
      declare function saveUser(input: string): Result<string, Error>
      declare function externalFunction(value: unknown): void

      const unhandled = saveUser('unhandled')
      externalFunction(unhandled)

      const matched = saveUser('matched')
      matched.match((value) => value, (error) => error.message)

      const unwrapped = saveUser('unwrapped')
      unwrapped.unwrapOr('fallback')

      const checked = saveUser('checked')
      if (checked.isErr()) {
        externalFunction(checked.error)
      }

      const returned = saveUser('returned')
      function passThrough(): Result<string, Error> {
        return returned
      }

      const discarded = saveUser('discarded')
      void discarded
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    equal(result.findings.length, 1);
    equal(result.findings[0]?.line, 12);
    equal(
      result.findings[0]?.message,
      "Unhandled Result<string, Error> value assigned to `unhandled`. Handle it, return it, or explicitly discard it with `void`.",
    );
  });

  it("allows assigned Result values returned inside object and array literals", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>

      function objectReturn(): { readonly result: Result<string, Error> } {
        const result = saveUser('object')
        return { result }
      }

      function propertyReturn(): { readonly saved: Result<string, Error> } {
        const result = saveUser('property')
        return { saved: result }
      }

      function arrayReturn(): readonly Result<string, Error>[] {
        const result = saveUser('array')
        return [result]
      }
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("allows assigned Result values returned through spreads, conditionals, and arrows", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>

      function objectSpreadReturn(): { readonly objectResult: Result<string, Error> } {
        const objectResult = saveUser('object')
        return { ...objectResult, objectResult }
      }

      function arraySpreadReturn(): readonly Result<string, Error>[] {
        const arrayResult = saveUser('array')
        return [...arrayResult, arrayResult]
      }

      const conditionalResult = saveUser('conditional')
      function conditionalReturn(flag: boolean): Result<string, Error> {
        return flag ? conditionalResult : saveUser('other')
      }

      const arrowResult = saveUser('arrow')
      const arrowReturn = (): Result<string, Error> => arrowResult
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("handles wrapped references, awaited consumers, and discarded tracked-result use", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = {
        readonly error?: E
        readonly value: T
        match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B
      }
      declare function saveUser(input: string): Result<string, Error>

      const source = saveUser('source')
      ;(saveUser((source as Result<string, Error>).value) satisfies Result<string, Error>)

      const returned = saveUser('returned')
      const passThrough = (): Result<string, Error> => ((returned as Result<string, Error>)!)

      async function run() {
        const consumed = saveUser('consumed')
        await consumed.match((value) => value, (error) => error.message)
      }
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    equal(result.findings.length, 1);
    equal(result.findings[0]?.message.startsWith("Ignored "), true);
  });

  it("does not track functions or objects only because their rendered type mentions Result", async () => {
    const rootDir = await createFixtureProject(`
      type StrictResultAsync<T, E> = { readonly error?: E; readonly value?: T }
      declare function buildUserValidation(): (userId: string) => StrictResultAsync<void, Error>
      declare function asFunction<T>(value: T): { readonly resolver: T }

      function createUsecase() {
        const validateUserExists = buildUserValidation()
        const findByUserId = buildUserValidation()

        return { validateUserExists, findByUserId }
      }

      function createContainer() {
        const register = {
          userCrudUsecase: asFunction({
            findById: buildUserValidation()
          })
        }

        return register
      }
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("allows returned usecase methods whose return types are ResultAsync", async () => {
    const rootDir = await createFixtureProject(`
      type StrictResultAsync<T, E> = { readonly error?: E; readonly value?: T }
      type AddressCreate = { readonly street: string }
      type AddressDocument = { readonly id: string }
      type AddressRepository = { readonly name: 'address' }
      type AddressUpdate = { readonly street?: string }
      type AppError = { readonly message: string }
      type UserRepository = { readonly name: 'user' }

      interface CreateAddressCrudUsecaseOptions {
        readonly addressRepository: AddressRepository
        readonly userRepository: UserRepository
      }

      declare function buildUserValidation(
        userRepository: UserRepository
      ): (userId: string) => StrictResultAsync<void, AppError>
      declare function buildFindByUserId(
        validateUserExists: (userId: string) => StrictResultAsync<void, AppError>,
        addressRepository: AddressRepository
      ): (userId: string) => StrictResultAsync<AddressDocument[], AppError>
      declare function buildEnsureAddressExists(
        validateUserExists: (userId: string) => StrictResultAsync<void, AppError>,
        addressRepository: AddressRepository
      ): (userId: string, addressId: string) => StrictResultAsync<AddressDocument, AppError>
      declare function buildCreate(
        validateUserExists: (userId: string) => StrictResultAsync<void, AppError>,
        addressRepository: AddressRepository
      ): (userId: string, address: AddressCreate) => StrictResultAsync<AddressDocument, AppError>
      declare function buildUpdate(
        ensureAddressExists: (userId: string, addressId: string) => StrictResultAsync<AddressDocument, AppError>,
        addressRepository: AddressRepository
      ): (userId: string, addressId: string, address: AddressUpdate) => StrictResultAsync<AddressDocument, AppError>
      declare function buildDeleteOne(
        ensureAddressExists: (userId: string, addressId: string) => StrictResultAsync<AddressDocument, AppError>,
        addressRepository: AddressRepository
      ): (userId: string, addressId: string) => StrictResultAsync<boolean, AppError>
      declare function buildSetDefault(
        ensureAddressExists: (userId: string, addressId: string) => StrictResultAsync<AddressDocument, AppError>,
        addressRepository: AddressRepository
      ): (userId: string, addressId: string) => StrictResultAsync<void, AppError>

      export const createAddressCrudUsecase = ({
        addressRepository,
        userRepository,
      }: CreateAddressCrudUsecaseOptions) => {
        const validateUserExists = buildUserValidation(userRepository)
        const findByUserId = buildFindByUserId(validateUserExists, addressRepository)
        const ensureAddressExists = buildEnsureAddressExists(validateUserExists, addressRepository)
        const create = buildCreate(validateUserExists, addressRepository)
        const update = buildUpdate(ensureAddressExists, addressRepository)
        const deleteOne = buildDeleteOne(ensureAddressExists, addressRepository)
        const setDefault = buildSetDefault(ensureAddressExists, addressRepository)

        return { findByUserId, create, update, deleteOne, setDefault }
      }
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("uses direct mode from tsconfig plugin config when no mode is passed", async () => {
    const rootDir = await createFixtureProject(
      `
        type Result<T, E> = { readonly error?: E; readonly value?: T }
        declare function saveUser(input: string): Result<string, Error>
        declare function externalFunction(value: unknown): void

        const unhandled = saveUser('unhandled')
        externalFunction(unhandled)
      `,
      { plugins: [{ name: "resultar-check", noDiscard: "error", noDiscardMode: "direct" }] },
    );

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("returns an Err when the project cannot be parsed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "resultar-check-invalid-"));
    tempDirs.push(rootDir);
    await writeFile(join(rootDir, "tsconfig.json"), "{");

    const result = findDiscardedResults({ rootDir });

    isTrue(!result.ok);
    isTrue(result.error instanceof Error);
  });
});
