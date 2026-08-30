// Usage: node build.mjs        -> one-shot build to dist/
//        node build.mjs --serve -> dev server on :8082 with live rebuild
//
// esbuild rather than Vite/webpack on purpose: it's a single small Go binary
// with no native-module install step, which matters a lot when the dev
// machine is Termux on a phone rather than a normal laptop.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const serve = process.argv.includes('--serve');

const opts = {
  entryPoints: {
    'index': 'src/index.ts',
    'demo/harness': 'src/demo/harness.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  define: { 'process.env.NODE_ENV': serve ? '"development"' : '"production"' },
};

mkdirSync('dist/demo', { recursive: true });
cpSync('index.html', 'dist/index.html');
cpSync('demo.html', 'dist/demo.html');

if (serve) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  const result = await ctx.serve({ servedir: 'dist', port: 8082 });
  console.log(`Wallet dev server: http://localhost:${result.port}`);
} else {
  await esbuild.build(opts);
  console.log('Built dist/index.js and dist/demo/harness.js');
}
