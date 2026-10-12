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
      testMatch: ['<rootDir>/{packages,apps,functions,infra}/**/*.test.ts'],
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
  ],
};
