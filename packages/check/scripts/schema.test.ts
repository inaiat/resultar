import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import jsonLanguageService, { type JSONSchema } from "vscode-json-languageservice";

const { getLanguageService, TextDocument } = jsonLanguageService;

const schemaUri = new URL("../schema.json", import.meta.url).href;
const schemaText = readFileSync(new URL(schemaUri), "utf8");
const tsconfigSchemaUri = "https://json.schemastore.org/tsconfig.json";

// Representative standard options keep CI offline. Set this path to also test a SchemaStore snapshot.
const tsconfigSchemaPath = process.env.RESULTAR_TSCONFIG_SCHEMA_PATH;
const tsconfigSchemaText =
  tsconfigSchemaPath === undefined
    ? JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        allOf: [{ $ref: "#/definitions/project" }],
        definitions: {
          project: {
            type: "object",
            properties: {
              extends: {
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
              include: { type: "array", items: { type: "string" } },
              compilerOptions: {
                type: "object",
                properties: {
                  strict: { type: "boolean" },
                  target: { type: "string", enum: ["ESNext", "ES2025"] },
                  moduleResolution: { type: "string", enum: ["NodeNext", "Bundler"] },
                  erasableSyntaxOnly: { type: "boolean" },
                  plugins: {
                    type: "array",
                    items: { type: "object", properties: { name: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      })
    : readFileSync(tsconfigSchemaPath, "utf8");

function setup(text: string) {
  const service = getLanguageService({
    schemaRequestService: async (uri) => {
      assert.equal(
        uri,
        tsconfigSchemaUri,
        "Only the standard tsconfig reference should be requested",
      );
      await Promise.resolve();
      return tsconfigSchemaText;
    },
  });
  service.configure({
    allowComments: true,
    schemas: [
      {
        uri: schemaUri,
        fileMatch: ["tsconfig.json"],
        schema: JSON.parse(schemaText) as JSONSchema,
      },
    ],
  });
  const document = TextDocument.create("file:///workspace/tsconfig.json", "jsonc", 1, text);
  return { service, document, parsed: service.parseJSONDocument(document) };
}

async function validate(text: string) {
  const { service, document, parsed } = setup(text);
  return service.doValidation(document, parsed);
}

async function complete(text: string) {
  const offset = text.indexOf("|");
  assert.notEqual(offset, -1, "A completion cursor is required");
  const { service, document, parsed } = setup(text.replace("|", ""));
  const result = await service.doComplete(document, document.positionAt(offset), parsed);
  return result?.items.map((item) => item.label) ?? [];
}

void test("completes standard top-level and compiler options through the schema reference", async () => {
  const root = await complete("{ | }");
  assert.ok(root.includes("extends"));
  assert.ok(root.includes("include"));
  const compiler = await complete('{ "compilerOptions": { | } }');
  for (const option of ["strict", "target", "moduleResolution", "erasableSyntaxOnly", "plugins"]) {
    assert.ok(compiler.includes(option), `Missing TypeScript completion: ${option}`);
  }
});

void test("completes Resultar options alongside standard plugin properties", async () => {
  const items = await complete(
    '{ "compilerOptions": { "plugins": [{ "name": "resultar-check", | }] } }',
  );
  for (const option of [
    "noDiscard",
    "noUnknownTaskRequirements",
    "unusedSuppression",
    "ignoreFilePatterns",
  ]) {
    assert.ok(items.includes(option), `Missing Resultar completion: ${option}`);
  }
});

void test("completes standard option values and Resultar severities", async () => {
  const targets = await complete('{ "compilerOptions": { "target": | } }');
  assert.ok(targets.some((target) => target.toLowerCase() === '"esnext"'));
  const severities = await complete(
    '{ "compilerOptions": { "plugins": [{ "name": "resultar-check", "noDiscard": | }] } }',
  );
  for (const severity of ['"error"', '"warning"', '"off"'])
    assert.ok(severities.includes(severity));
});

void test("accepts combined TypeScript and Resultar configuration with JSONC syntax", async () => {
  assert.deepEqual(
    await validate(`{
    // Standard compiler options and native checker configuration coexist.
    "extends": ["./base.json"],
    "include": ["src/**/*.ts"],
    "compilerOptions": {
      "strict": true,
      "target": "ESNext",
      "moduleResolution": "NodeNext",
      "erasableSyntaxOnly": true,
      "plugins": [
        { "name": "resultar-check", "noUnknownTaskRequirements": "error", "unusedSuppression": "off" },
        { "name": "another-plugin", "noDiscard": "custom-value" },
      ],
    },
  }`),
    [],
  );
});

void test("rejects invalid standard compiler and project options", async () => {
  await Promise.all(
    [
      '{ "compilerOptions": { "strict": "yes" } }',
      '{ "compilerOptions": { "target": "ES9999" } }',
      '{ "extends": 42 }',
    ].map(async (text) => {
      const diagnostics = await validate(text);
      assert.ok(diagnostics.length > 0, `Invalid standard configuration was accepted: ${text}`);
      assert.ok(
        diagnostics.every(
          (diagnostic) => diagnostic.code !== jsonLanguageService.ErrorCode.SchemaResolveError,
        ),
      );
    }),
  );
});

void test("rejects invalid Resultar severities and file patterns", async () => {
  await Promise.all(
    [
      '"noUnknownTaskRequirements": "fatal"',
      '"unusedSuppression": "fatal"',
      '"ignoreFilePatterns": 42',
    ].map(async (option) => {
      const diagnostics = await validate(
        `{ "compilerOptions": { "plugins": [{ "name": "resultar-check", ${option} }] } }`,
      );
      assert.ok(diagnostics.length > 0, `Invalid Resultar configuration was accepted: ${option}`);
      assert.ok(
        diagnostics.every(
          (diagnostic) => diagnostic.code !== jsonLanguageService.ErrorCode.SchemaResolveError,
        ),
      );
    }),
  );
});
