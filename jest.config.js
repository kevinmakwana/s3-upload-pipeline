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
      testMatch: ['<rootDir>/{packages,apps,functions,infra}/**/*.test.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk.out/'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform: tsJest,
      testMatch: ['<rootDir>/tests/integration/**/*.int.test.ts'],
      testTimeout: 600_000,
    },
  ],
};
