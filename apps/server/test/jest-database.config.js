module.exports = {
  rootDir: '..',
  roots: [
    '<rootDir>/test/database',
    '<rootDir>/test/auth',
    '<rootDir>/test/authorization',
    '<rootDir>/test/agents',
    '<rootDir>/test/build-templates',
    '<rootDir>/test/projects',
    '<rootDir>/test/tasks',
    '<rootDir>/test/task-logs',
    '<rootDir>/test/artifacts',
    '<rootDir>/test/overview',
    '<rootDir>/test/security',
  ],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  testTimeout: 30_000,
};
