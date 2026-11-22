import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { setWasmSource, svgToPng } from './png';

test('renders a PNG in Node', async () => {
  setWasmSource(() => readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm'));
  const png = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', 20);
  expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
