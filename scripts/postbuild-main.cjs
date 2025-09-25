#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

const writePackage = async (dir) => {
  const filePath = path.join(dir, 'package.json');
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify({ type: 'commonjs' }, null, 2);
  await fs.writeFile(filePath, `${content}\n`, 'utf8');
};

async function main() {
  const root = process.cwd();
  await writePackage(path.join(root, 'dist/main'));
  await writePackage(path.join(root, 'dist/shared'));
}

main().catch((error) => {
  console.error('[postbuild-main] Failed to write package manifests', error);
  process.exit(1);
});
