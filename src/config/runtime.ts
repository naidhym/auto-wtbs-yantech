export const MINIMUM_NODE_VERSION = '22.13.0';

interface ParsedNodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseNodeVersion(version: string): ParsedNodeVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);

  if (match === null) {
    throw new Error(`Unable to parse Node.js version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function assertSupportedNodeVersion(version: string): void {
  const current = parseNodeVersion(version);
  const minimum = parseNodeVersion(MINIMUM_NODE_VERSION);
  const isSupported =
    current.major > minimum.major ||
    (current.major === minimum.major && current.minor > minimum.minor) ||
    (current.major === minimum.major &&
      current.minor === minimum.minor &&
      current.patch >= minimum.patch);

  if (!isSupported) {
    throw new Error(
      `Auto WTB Bot requires Node.js ${MINIMUM_NODE_VERSION} or newer; received ${version}`,
    );
  }
}
