import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', '**/*.d.ts'] },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
      ],
      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'warn',
    },
  }
);
