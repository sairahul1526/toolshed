/**
 * SVG to PNG with resvg (WebAssembly). The engine draws text as outlines, so no fonts are loaded here.
 * The Worker gets the compiled module from the bundler; tests hand in the bytes with `setWasmSource`.
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';

type WasmSource = () => Promise<WebAssembly.Module | BufferSource>;

let source: WasmSource = async () => (await import('@resvg/resvg-wasm/index_bg.wasm')).default;
let ready: Promise<void> | null = null;

/** Tests run in Node, where a `.wasm` import does not compile itself. */
export function setWasmSource(next: WasmSource): void {
  source = next;
  ready = null;
}

function init(): Promise<void> {
  ready ??= source().then((wasm) => initWasm(wasm));
  return ready;
}

export async function svgToPng(svg: string, width: number): Promise<Uint8Array> {
  await init();
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
