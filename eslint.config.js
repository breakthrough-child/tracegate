import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      '.tracegate/**',
      'examples/**/.tracegate/**',
      'docs/samples/**',
      'experiments/results/**',
      'python/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['**/*.mjs', '**/*.js'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } } },
);
