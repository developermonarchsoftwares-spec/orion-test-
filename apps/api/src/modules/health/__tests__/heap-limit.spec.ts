import { DEFAULT_HEAP_LIMIT_BYTES, heapLimitBytes } from '../heap-limit';

describe('health heap limit', () => {
  it('is 1 GiB unless configured', () => {
    expect(DEFAULT_HEAP_LIMIT_BYTES).toBe(1073741824);
    expect(heapLimitBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_HEAP_LIMIT_BYTES);
    expect(heapLimitBytes({ HEALTH_HEAP_LIMIT_MB: '' } as NodeJS.ProcessEnv)).toBe(DEFAULT_HEAP_LIMIT_BYTES);
  });
  it('takes a whole number of megabytes of 128 or more', () => {
    expect(heapLimitBytes({ HEALTH_HEAP_LIMIT_MB: '8192' } as NodeJS.ProcessEnv)).toBe(8192 * 1024 * 1024);
    expect(heapLimitBytes({ HEALTH_HEAP_LIMIT_MB: ' 256 ' } as NodeJS.ProcessEnv)).toBe(256 * 1024 * 1024);
    expect(heapLimitBytes({ HEALTH_HEAP_LIMIT_MB: '128' } as NodeJS.ProcessEnv)).toBe(128 * 1024 * 1024);
  });
  it('ignores anything else, so a typo cannot disable the check or set a limit the process already exceeds', () => {
    for (const bad of ['127', '0', '-5', '1e9', '12.5', 'lots', '99999999']) {
      expect(heapLimitBytes({ HEALTH_HEAP_LIMIT_MB: bad } as NodeJS.ProcessEnv)).toBe(DEFAULT_HEAP_LIMIT_BYTES);
    }
  });
});
