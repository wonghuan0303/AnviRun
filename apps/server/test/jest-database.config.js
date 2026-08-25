module.exports = {
  rootDir: '..',
  roots: ['<rootDir>/test/database', '<rootDir>/test/auth', '<rootDir>/test/authorization'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  testTimeout: 30_000,
};
