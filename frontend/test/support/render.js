// Loads frontend modules (including JSX) through Vite's server-side module loader and renders components to HTML,
// so screens can be tested in Node without a browser. This file is a helper, not a test.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

export const frontendRoot = fileURLToPath(new URL('../..', import.meta.url));
let serverPromise;

function server() {
  serverPromise ||= createServer({
    root: frontendRoot,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return serverPromise;
}

export async function load(modulePath) {
  return (await server()).ssrLoadModule(modulePath);
}

export async function render(modulePath, exportName, props) {
  const module = await load(modulePath);
  return renderToStaticMarkup(createElement(module[exportName], props));
}

// Visible text only, with tags removed, for readable assertions.
export function textOf(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

export async function closeRenderer() {
  if (serverPromise) await (await serverPromise).close();
  serverPromise = undefined;
}

export function sourceFiles(directory = path.join(frontendRoot, 'src')) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : [{ path: full, text: readFileSync(full, 'utf8') }];
  });
}

export function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}
