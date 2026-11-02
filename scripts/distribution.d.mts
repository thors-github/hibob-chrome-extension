export interface ReleasePolicy { tag: string; version: string; displayVersion: string; prerelease: boolean; stableReleaseReady: boolean; }
export function releasePolicy(tag: string, manifest: Record<string, unknown>, readiness: Record<string, unknown>): ReleasePolicy;
export function publishedStoreUrl(env: Record<string, string | undefined>): string | null;
export function storeConfiguration(env: Record<string, string | undefined>): { publisherId: string; extensionId: string };
export function resolveWorkflowRelease(env: Record<string, string | undefined>, fetcher?: typeof fetch, inputs?: {manifest: Record<string, unknown>; readiness: Record<string, unknown>}): Promise<Partial<ReleasePolicy> & { enabled: boolean; bootstrap?: boolean; reason?: string }>;
export function sha256(bytes: Uint8Array): string;
export const zipName: string;
export const repository: string;
