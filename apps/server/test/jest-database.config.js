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
  ],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  testTimeout: 30_000,
};
