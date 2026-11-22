/** Types for the plain-JavaScript engine, so the Worker can import it with full checking. */

export interface EngineFont {
  family: string;
  style: string;
  weight: number;
  variable: boolean;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  capHeight: number;
  numGlyphs: number;
  glyphIndex(codePoint: number): number;
  advance(glyph: number): number;
  path(glyph: number): string;
  coverage(): [number, number][];
}

export class FontError extends Error {
  readonly code: 'font_unreadable' | 'font_is_woff' | 'font_is_collection' | 'font_no_unicode' | 'font_cff_outlines' | 'font_no_outlines';
}

export function parseFont(source: ArrayBuffer | Uint8Array): EngineFont;
export function encodeRanges(ranges: [number, number][]): string;

export interface CatalogFile {
  key: string;
  ranges: string;
}
export interface CatalogFamily {
  id: string;
  name: string;
  kind?: string;
  faces: { weight: number; files: CatalogFile[] }[];
}
export interface Catalog {
  families: CatalogFamily[];
  emoji: CatalogFile | null;
  fallback: string;
}

export const DEFAULT_FAMILY: string;
export const FAMILIES: { id: string; name: string; kind: string; faces: { weight: number; files: { path: string; ranges: string }[] }[] }[];
export const FIELD_PATTERN: RegExp;

export function buildCatalog(custom?: CatalogFamily[]): Catalog;

export type WarningCode = 'missing_glyphs' | 'complex_script' | 'text_cut' | 'image_missing' | 'font_missing';
export interface RenderWarning {
  layer: string;
  code: WarningCode;
  detail?: string;
}
export interface RenderResult {
  svg: string;
  warnings: RenderWarning[];
  /** The size each text layer ended up at, after shrinking to fit. */
  sizes: Record<string, number>;
}

/** The template document. The Worker validates it with Zod before it gets here. */
export type EngineDoc = Record<string, unknown>;
export type Values = Record<string, string>;

export function isColor(value: unknown): boolean;
export function fieldValue(doc: EngineDoc, values: Values, name: string): string;
export function usedFields(doc: EngineDoc): string[];
export function plan(doc: EngineDoc, values: Values, catalog: Catalog): { fonts: string[]; images: string[] };
export function render(
  doc: EngineDoc,
  values: Values,
  resources: { catalog: Catalog; fonts: Map<string, EngineFont>; images: Map<string, string>; width?: number },
): RenderResult;

export interface DrawHost {
  catalog: Catalog;
  font(key: string): Promise<EngineFont | null>;
  image(src: string): Promise<string | null>;
  width?: number;
}
export function draw(doc: EngineDoc, values: Values, host: DrawHost): Promise<RenderResult>;
