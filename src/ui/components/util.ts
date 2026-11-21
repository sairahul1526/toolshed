/** Small helpers shared by the components. */

export type ClassValue = string | false | null | undefined;

/** Joins class names, skipping empty ones. */
export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}

/** A stable id for a label, hint or error when the caller did not pass one. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}
