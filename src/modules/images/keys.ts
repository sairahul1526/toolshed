/** Where the module keeps files in the shared bucket. Everything sits under images/<workspace>/. */

export const assetKey = (orgId: string, id: string): string => `images/${orgId}/assets/${id}`;
export const renderKey = (orgId: string, hash: string, format: string): string => `images/${orgId}/renders/${hash}.${format}`;
export const remoteKey = (orgId: string, urlHash: string): string => `images/${orgId}/remote/${urlHash}`;
