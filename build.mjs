// Builds index.html (standalone page) from src/ with the manifold WASM inlined.
// Usage: npm install && npm run build
import fs from 'fs';
const core = fs.readFileSync('src/lampcore.js', 'utf8').replace(/^export /gm, '');
const b64 = fs.readFileSync('node_modules/manifold-3d/manifold.wasm').toString('base64');
const body = fs.readFileSync('src/app.html', 'utf8')
  .replace('/*__LAMPCORE__*/', () => core)
  .replace('__WASM_B64__', () => b64);
const head = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
fs.writeFileSync('index.html', head + body + '</body></html>');
fs.writeFileSync('dist-claude-artifact.html', body);
console.log('wrote index.html', (fs.statSync('index.html').size / 1024).toFixed(0), 'KB');
