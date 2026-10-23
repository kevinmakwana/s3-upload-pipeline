// Jest transformer for the few dependencies that ship ES modules only (NestJS 12, jose 6; see jest.config.js).
// The tests run as CommonJS, and Node 22 cannot `require()` an ES module inside Jest's sandbox, so these
// packages are rewritten to CommonJS on load. Everything else is left alone.
const { transformSync } = require('esbuild');

// `import.meta` does not exist in CommonJS: point the few uses at the equivalents.
const importMeta = {
  'import.meta.url': '__importMetaUrl',
  'import.meta.dirname': '__dirname',
  'import.meta.filename': '__filename',
};

module.exports = {
  process(source, filename) {
    const { code, map } = transformSync(source, {
      loader: 'js',
      format: 'cjs',
      target: 'node22',
      sourcefile: filename,
      sourcemap: 'external',
      define: importMeta,
      banner: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    });
    return { code, map };
  },
};
