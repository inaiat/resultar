import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
  },
  lint: {
    jsPlugins: [{ name: 'resultar', specifier: 'resultar-lint/oxlint' }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'resultar/no-discard': 'error',
    },
  },
})
