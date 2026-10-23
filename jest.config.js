/** @type {import('jest').Config} */
// Dependencies that ship ES modules only. Jest's CommonJS runtime cannot require() them on Node 22, so they
// are rewritten to CommonJS when loaded. Add a package here if a test fails with "Must use import to load ES Module".
const esmOnly = '(?:@nestjs/(?:common|core|platform-express|testing)|jose)';
const tsJest = {
  '^.+\\.tsx?$': [
    'ts-jest',
    {
      tsconfig: '<rootDir>/tsconfig.jest.json',
    },
  ],
  [`/node_modules/${esmOnly}/.+\\.js$`]: '<rootDir>/tests/support/esm-to-cjs.cjs',
};
const transformIgnorePatterns = [`/node_modules/(?!${esmOnly}/)`];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform: tsJest,
      transformIgnorePatterns,
      modulePathIgnorePatterns: ['<rootDir>/infra/cdk.out'],
      testMatch: ['<rootDir>/{packages,apps,functions,infra}/**/*.test.ts', '<rootDir>/tests/repo/**/*.test.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk.out/'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform: tsJest,
      transformIgnorePatterns,
      modulePathIgnorePatterns: ['<rootDir>/infra/cdk.out'],
      setupFiles: ['<rootDir>/tests/integration/setup.ts'],
      testMatch: ['<rootDir>/tests/integration/**/*.int.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/integration/timeout.ts'],
    },
    {
      // Real AWS: only run on purpose (npm run smoke:aws), never as part of `npm test`.
      displayName: 'smoke',
      testEnvironment: 'node',
      transform: tsJest,
      transformIgnorePatterns,
      modulePathIgnorePatterns: ['<rootDir>/infra/cdk.out'],
      setupFiles: ['<rootDir>/tests/smoke/setup.ts'],
      testMatch: ['<rootDir>/tests/smoke/**/*.smoke.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/integration/timeout.ts'],
    },
  ],
};
