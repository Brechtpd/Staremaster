#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

const writePackage = async (dir) => {
  const filePath = path.join(dir, 'package.json');
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify({ type: 'commonjs' }, null, 2);
  await fs.writeFile(filePath, `${content}\n`, 'utf8');
};

const ensureAlias = async (root, alias, target) => {
  const nodeModules = path.join(root, 'dist', 'main', 'node_modules');
  const aliasPath = path.join(nodeModules, alias);
  const relativeTarget = path.relative(path.dirname(aliasPath), target);
  await fs.mkdir(path.dirname(aliasPath), { recursive: true });
  try {
    await fs.rm(aliasPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(relativeTarget, aliasPath, type);
};

async function main() {
  const root = process.cwd();
  await writePackage(path.join(root, 'dist/main'));
  await writePackage(path.join(root, 'dist/shared'));
  await ensureAlias(root, '@shared', path.join(root, 'dist', 'shared'));
}

main().catch((error) => {
  console.error('[postbuild-main] Failed to write package manifests', error);
  process.exit(1);
});
