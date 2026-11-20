// Shared list of hash settings the spike measures, in Node and in workerd.
export const CASES = [
  { id: "scrypt-native-N16384-r16-p1", kind: "scrypt-native", N: 16384, r: 16, p: 1, note: "Better Auth default params, native" },
  { id: "scrypt-native-N8192-r8-p1", kind: "scrypt-native", N: 8192, r: 8, p: 1 },
  { id: "scrypt-native-N16384-r8-p1", kind: "scrypt-native", N: 16384, r: 8, p: 1 },
  { id: "scrypt-native-N32768-r8-p1", kind: "scrypt-native", N: 32768, r: 8, p: 1 },
  { id: "scrypt-native-N131072-r8-p1", kind: "scrypt-native", N: 131072, r: 8, p: 1, note: "OWASP minimum" },
  { id: "scrypt-noble-N16384-r16-p1", kind: "scrypt-noble", N: 16384, r: 16, p: 1, note: "Better Auth default (pure JS)" },
  { id: "pbkdf2-sha256-10000", kind: "pbkdf2", hash: "SHA-256", iterations: 10000 },
  { id: "pbkdf2-sha256-50000", kind: "pbkdf2", hash: "SHA-256", iterations: 50000 },
  { id: "pbkdf2-sha256-100000", kind: "pbkdf2", hash: "SHA-256", iterations: 100000, note: "workerd max iterations" },
  { id: "pbkdf2-sha256-600000", kind: "pbkdf2", hash: "SHA-256", iterations: 600000, note: "OWASP 2023" },
  { id: "pbkdf2-sha512-100000", kind: "pbkdf2", hash: "SHA-512", iterations: 100000 },
  { id: "pbkdf2-sha512-210000", kind: "pbkdf2", hash: "SHA-512", iterations: 210000, note: "OWASP 2023" },
];
