import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Execute the real source body with mocked import boundaries; never call live auth.
export async function loadSource(relative, { stubs = {}, globals = {} } = {}) {
  const context = createContext({
    URL, URLSearchParams, Buffer, console, setTimeout, clearTimeout, AbortSignal,
    process: { env: {}, stderr: { write() {} } },
    fetch: () => { throw new Error('Unexpected network request'); },
    ...globals,
  });
  const modules = new Map();
  async function getModule(url) {
    if (modules.has(url)) return modules.get(url);
    let module;
    const stub = stubs[url];
    if (stub || url.startsWith('node:')) {
      const exports = stub || await import(url);
      module = new SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: url });
    } else {
      module = new SourceTextModule(readFileSync(new URL(url), 'utf8'), { context, identifier: url });
    }
    modules.set(url, module);
    await module.link(async (specifier, referencing) => {
      if (Object.hasOwn(stubs, specifier)) return getModule(specifier);
      if (specifier.startsWith('node:')) return getModule(specifier);
      const resolved = specifier.startsWith('.')
        ? new URL(specifier, referencing.identifier).href
        : pathToFileURL(createRequire(referencing.identifier).resolve(specifier)).href;
      return getModule(resolved);
    });
    return module;
  }
  const root = await getModule(new URL(relative, import.meta.url).href);
  await root.evaluate();
  return root.namespace;
}
