import { describe, expect, it } from 'vitest';

import {
  assertSupportedNodeVersion,
  parseNodeVersion,
} from '../src/config/runtime.js';

describe('runtime guard', () => {
  it('accepts Node.js 22.13.0 and newer', () => {
    expect(() => assertSupportedNodeVersion('22.13.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('22.23.2')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.1.0')).not.toThrow();
  });

  it('rejects versions older than Node.js 22.13.0', () => {
    expect(() => assertSupportedNodeVersion('22.12.99')).toThrow(
      'requires Node.js 22.13.0 or newer',
    );
    expect(() => assertSupportedNodeVersion('20.19.0')).toThrow(
      'requires Node.js 22.13.0 or newer',
    );
  });

  it('rejects malformed versions', () => {
    expect(() => parseNodeVersion('unknown')).toThrow('Unable to parse');
  });
});
