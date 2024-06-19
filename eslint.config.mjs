import eslint from '@eslint/js'
import n from 'eslint-plugin-n'
import unicorn from 'eslint-plugin-unicorn'
import tseslint from 'typescript-eslint'

const customRules = {
  '@typescript-eslint/array-type': ['error', { 'default': 'array-simple' }],
  '@typescript-eslint/consistent-type-exports': 'error',
  '@typescript-eslint/consistent-type-imports': 'error',
  '@typescript-eslint/no-unused-vars': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      'args': 'all',
      'argsIgnorePattern': '^_',
      'caughtErrors': 'all',
      'caughtErrorsIgnorePattern': '^_',
      'destructuredArrayIgnorePattern': '^_',
      'varsIgnorePattern': '^_',
      'ignoreRestSiblings': true,
    },
  ],
  'no-console': 'error',

  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-explicit-any': 'warn',

  'capitalized-comments': 'off',
  'new-cap': 'off',
  'n/no-missing-import': 'off',
  'unicorn/prevent-abbreviations': 'off',

  '@typescript-eslint/consistent-type-definitions': 'off',
  '@typescript-eslint/member-delimiter-style': 'off',
  '@typescript-eslint/prefer-readonly-parameter-types': 'off',
  '@typescript-eslint/naming-convention': 'off',

  '@typescript-eslint/object-curly-spacing': 'off',

  'n/no-unpublished-import': 'off',
  'unicorn/import-style': 'off',
  'unicorn/no-array-method-this-argument': 'off',
  'unicorn/no-array-callback-reference': 'off',
}

const languageOptions = {
  parserOptions: {
    project: true,
  },
}

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  n.configs['flat/recommended-module'],
  unicorn.configs['flat/recommended'],
  {
    ignores: ['*.mjs', 'dist', 'coverage/', 'report/'],
  },
  {
    languageOptions,
    rules: customRules,
  },
  {
    files: ['**/tests/**'],
    languageOptions,
    rules: {
      ...customRules,
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'no-console': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/consistent-function-scoping': 'off',
    },
  },
)
