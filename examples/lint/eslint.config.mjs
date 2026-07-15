import parser from "@babel/eslint-parser";
import resultar from "resultar-check/eslint";

const resultarRules = {
  "resultar/no-await-in-safe-try": "error",
  "resultar/no-tagged-error-constructor-override": "error",
  "resultar/no-throw": "error",
  "resultar/no-try-catch": "error",
  "resultar/no-try-catch-in-safe-try": "error",
  "resultar/prefer-tagged-error": "error",
  "resultar/tagged-error-name-match": "error",
  "resultar/typed-catch-mapper": "error",
  "resultar/yield-star-in-safe-try": "error",
};

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: {
            plugins: ["typescript"],
          },
          plugins: ["@babel/plugin-syntax-typescript"],
        },
        ecmaVersion: "latest",
        requireConfigFile: false,
        sourceType: "module",
      },
    },
    plugins: { resultar },
    rules: resultarRules,
  },
];
