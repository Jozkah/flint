import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'

// Accessibility rules, advisory for now: every recommended rule at 'warn'.
const a11yWarnRules = Object.fromEntries(
  Object.keys(jsxA11y.flatConfigs.recommended.rules).map((name) => [name, 'warn'])
)

export default tseslint.config(
  { ignores: ['dist', 'coverage', '**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    languageOptions: jsxA11y.flatConfigs.recommended.languageOptions,
    rules: a11yWarnRules,
  },
  {
    // The phone app (src/mobile) runs in a phone's browser, not in Tauri.
    files: ['src/mobile/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/*', '@janhq/*'],
              message: 'The phone app runs in a browser; it cannot use Tauri or the desktop extensions.',
            },
          ],
        },
      ],
    },
  },
)
