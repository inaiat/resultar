import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    jsPlugins: [{ name: "resultar", specifier: "resultar-lint/oxlint" }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "resultar/no-discard": "error",
      "resultar/no-tagged-error-constructor-override": "error",
      "resultar/no-try-catch-in-safe-try": "error",
      "resultar/no-useless-recovery": "error",
      "resultar/prefer-and-then": "error",
      "resultar/prefer-map-err": "error",
      "resultar/prefer-tagged-error": "error",
      "resultar/tagged-error-name-match": "error",
      "resultar/typed-catch-mapper": "error",
      "resultar/unsafe-result-type-assertion": "error",
      "resultar/yield-star-in-safe-try": "error",
    },
  },
});
