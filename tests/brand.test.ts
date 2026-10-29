import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { brand } from '../src/brand.js';

it('keeps the package, lockfile, CLI and default data path aligned with Runply', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  expect(brand).toEqual({ name: 'Runply', command: 'runply', packageName: 'runply', dataDirectory: '.runply' });
  expect(manifest.name).toBe(brand.packageName);
  expect(manifest.bin).toEqual({ [brand.command]: './dist/cli.js' });
  expect(lock.name).toBe(manifest.name);
  expect(lock.packages[''].name).toBe(manifest.name);
  expect(lock.packages[''].bin).toEqual({ [brand.command]: 'dist/cli.js' });
  expect(lock.version).toBe(manifest.version);
  expect(manifest.license).toBe('MIT');
});