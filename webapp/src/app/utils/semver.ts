/** Parse a semver string into [major, minor, patch]. Returns [0,0,0] on invalid input. */
export function parseSemver(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/** Returns true if versionA > versionB (semver comparison). */
export function isNewerVersion(versionA: string, versionB: string): boolean {
  const [aMaj, aMin, aPat] = parseSemver(versionA);
  const [bMaj, bMin, bPat] = parseSemver(versionB);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

/** Format bytes to human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
