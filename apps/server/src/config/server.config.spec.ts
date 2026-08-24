import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  resolveServerListenOptions,
} from './server.config';

describe('resolveServerListenOptions', () => {
  it('falls back to defaults when nothing is configured', () => {
    expect(resolveServerListenOptions({})).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
    });
  });

  it('uses the configured host and port', () => {
    expect(resolveServerListenOptions({ SERVER_HOST: '0.0.0.0', SERVER_PORT: '8080' })).toEqual({
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it('trims the host and ignores blank values', () => {
    expect(resolveServerListenOptions({ SERVER_HOST: '  ' }).host).toBe(DEFAULT_SERVER_HOST);
    expect(resolveServerListenOptions({ SERVER_HOST: ' localhost ' }).host).toBe('localhost');
  });

  it.each(['', '   ', 'not-a-port', '0', '-1', '70000'])('ignores the invalid port %p', (value) => {
    expect(resolveServerListenOptions({ SERVER_PORT: value }).port).toBe(DEFAULT_SERVER_PORT);
  });
});
