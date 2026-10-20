/** @type {import('jest').Config} */
const tsJest = {
  '^.+\\.tsx?$': [
    'ts-jest',
    {
      tsconfig: '<rootDir>/tsconfig.jest.json',
    },
  ],
};

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform: tsJest,
      modulePathIgnorePatterns: ['<rootDir>/infra/cdk.out'],
      testMatch: ['<rootDir>/{packages,apps,functions,infra}/**/*.test.ts', '<rootDir>/tests/repo/**/*.test.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk.out/'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform: tsJest,
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
      modulePathIgnorePatterns: ['<rootDir>/infra/cdk.out'],
      setupFiles: ['<rootDir>/tests/smoke/setup.ts'],
      testMatch: ['<rootDir>/tests/smoke/**/*.smoke.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/integration/timeout.ts'],
    },
  ],
};
