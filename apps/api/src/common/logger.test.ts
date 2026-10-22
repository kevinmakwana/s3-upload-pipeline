import { JsonLogger, errorFields } from './logger';

function capture(level: ConstructorParameters<typeof JsonLogger>[0] = 'info') {
  const lines: string[] = [];
  const logger = new JsonLogger(level, (l) => lines.push(l));
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('JsonLogger', () => {
  it('writes one JSON object per line with level, time, message and the fields', () => {
    const { logger, parsed, lines } = capture();
    logger.event('info', 'request', { requestId: 'r1', status: 200 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(parsed()[0]).toMatchObject({ level: 'info', message: 'request', requestId: 'r1', status: 200 });
    expect(Date.parse(parsed()[0]!.time as string)).not.toBeNaN();
  });

  it('keeps hostile text on its own line (newlines and quotes are escaped)', () => {
    const { logger, lines, parsed } = capture();
    logger.event('warn', 'line one\n{"level":"error","message":"forged"}', { path: '/a"b\r\nx' });
    expect(lines).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({ level: 'warn' });
  });

  it('drops events below the configured level, and everything when silent', () => {
    const warn = capture('warn');
    warn.logger.event('debug', 'd');
    warn.logger.event('info', 'i');
    warn.logger.event('warn', 'w');
    warn.logger.event('error', 'e');
    expect(warn.parsed().map((l) => l.level)).toEqual(['warn', 'error']);

    const silent = capture('silent');
    silent.logger.event('error', 'e');
    expect(silent.lines).toEqual([]);
  });

  it("turns Nest's own log calls into the same format, keeping the context and the stack", () => {
    const { logger, parsed } = capture('debug');
    logger.log('Starting Nest application...', 'NestFactory');
    logger.warn('careful', 'Ctx');
    logger.debug('details', 'Ctx');
    logger.verbose('more', 'Ctx');
    logger.error('boom', 'Error: boom\n    at x (file.ts:1:1)', 'ExceptionsHandler');
    logger.fatal('dead', 'Bootstrap');
    expect(parsed()).toMatchObject([
      { level: 'info', message: 'Starting Nest application...', context: 'NestFactory' },
      { level: 'warn', message: 'careful', context: 'Ctx' },
      { level: 'debug', message: 'details', context: 'Ctx' },
      { level: 'debug', message: 'more', context: 'Ctx' },
      { level: 'error', message: 'boom', context: 'ExceptionsHandler', stack: 'Error: boom\n    at x (file.ts:1:1)' },
      { level: 'error', message: 'dead', context: 'Bootstrap' },
    ]);
  });

  it('copes with messages that are not strings', () => {
    const { logger, parsed } = capture();
    logger.log({ a: 1 });
    logger.error(new Error('as an error object'));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.log(circular);
    const lines = parsed();
    expect(lines[0]!.message).toBe('{"a":1}');
    expect(lines[1]!.message).toBe('as an error object');
    expect(lines).toHaveLength(3); // the circular one did not throw
  });

  it('describes an error without leaking a non-Error value verbatim', () => {
    expect(errorFields(new TypeError('bad'))).toMatchObject({ errorName: 'TypeError', errorMessage: 'bad', stack: expect.stringContaining('TypeError') });
    expect(errorFields('just a string')).toEqual({ errorName: 'NonError', errorMessage: 'just a string' });
    expect(errorFields({ secret: 'x' })).toEqual({ errorName: 'NonError', errorMessage: 'Non-error value thrown' });
  });
});
