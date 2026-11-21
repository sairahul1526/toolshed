/** Turns a User-Agent into the few words people recognise: "Chrome on macOS". No device database. */
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export interface Device {
  browser: string | null;
  os: string | null;
  /** "Chrome on macOS", or "Unknown device" when the browser sent nothing useful. */
  label: string;
  kind: 'phone' | 'laptop';
}

export function describeDevice(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null;
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'Unknown device');
  return { browser, os, label, kind: os === 'iPhone' || os === 'Android' ? 'phone' : 'laptop' };
}
