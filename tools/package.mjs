import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = ['manifest.json', 'background.js', 'content.js', 'shared.js', 'hook.js', ...Object.values(manifest.icons).map(String)];
for (const file of files) if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing runtime asset: ${file}`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'xfr-package-'));
const out = path.join(root, 'dist', `x-follow-radar-${manifest.version}.zip`);
try {
  for (const file of files) { const to = path.join(stage, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(root, file), to); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-q', '-X', '-r', out, '.'], { cwd: stage });
  console.log(out);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
