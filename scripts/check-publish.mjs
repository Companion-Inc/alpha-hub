import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const packageName = '@companion-ai/alpha-hub';

export function assertPublishContext(env, manifest) {
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'Companion-Inc/alpha-hub') {
    throw new Error('Publication is restricted to Companion-Inc/alpha-hub main.');
  }
  if (manifest.name !== packageName || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Unexpected package identity or non-stable version.');
  }
}

export async function shouldPublish(manifest, fetchRegistry = fetch) {
  if (manifest.name !== packageName || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Unexpected package identity or non-stable version.');
  }
  const response = await fetchRegistry(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  // Only an explicit npm package-not-found response permits a first publication.
  // Network errors, redirects, bad JSON, authentication errors and 5xx all fail closed.
  const metadata = await response.json();
  if (response.status === 404 && metadata?.error === 'Not found') return true;
  if (response.status !== 200 || metadata?.name !== packageName ||
      !metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions)) {
    throw new Error(`Invalid registry metadata (HTTP ${response.status}).`);
  }
  if (Object.hasOwn(metadata.versions, manifest.version)) {
    const published = metadata.versions[manifest.version];
    if (published?.name !== packageName || published.version !== manifest.version) {
      throw new Error('Published version identity does not match.');
    }
    return false;
  }
  const latest = metadata['dist-tags']?.latest;
  if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest) ||
      metadata.versions[latest]?.version !== latest || metadata.versions[latest]?.name !== packageName) {
    throw new Error('Registry latest version is missing or invalid.');
  }
  // Do not accidentally move latest backwards when old main history is rerun.
  const localParts = manifest.version.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);
  const firstDifference = localParts.findIndex((part, index) => part !== latestParts[index]);
  if (firstDifference < 0 || localParts[firstDifference] <= latestParts[firstDifference]) {
    throw new Error('Refusing to publish a version older than registry latest.');
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8'));
  assertPublishContext(process.env, manifest);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  const publish = await shouldPublish(manifest);
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  console.log(`${manifest.name}@${manifest.version}: ${publish ? 'not published' : 'already published'}`);
}
