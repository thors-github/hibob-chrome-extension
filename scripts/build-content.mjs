import { build } from 'esbuild';
await build({ entryPoints: ['src/content.ts'], bundle: true, outfile: 'dist/content.js', format: 'iife', target: 'chrome114', sourcemap: false, legalComments: 'eof' });
