import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FileStore } from '@engine/orm/filestore';

/**
 * The S3 file store behind `ir.attachment` (A-1 Files). The bucket is the one
 * `amplify/storage/resource.ts` defines, read from `amplify_outputs.json` —
 * the same file the database details come from — or from
 * `RODEO_FILES_BUCKET` / `RODEO_FILES_REGION`.
 *
 * Without a bucket, or without `@aws-sdk/client-s3` installed, this returns
 * null and payloads stay in the database, which is what a local PGlite box
 * wants anyway.
 */

export interface BucketConfig { bucket: string; region: string }

/** The bucket to use, from the environment or from `amplify_outputs.json`. */
export function filesBucketConfig(): BucketConfig | null {
  const bucket = process.env.RODEO_FILES_BUCKET?.trim();
  if (bucket) return { bucket, region: process.env.RODEO_FILES_REGION?.trim() || process.env.AWS_REGION?.trim() || 'us-east-1' };
  try {
    const path = process.env.RODEO_OUTPUTS?.trim() || resolve(process.cwd(), 'amplify_outputs.json');
    const outputs = JSON.parse(readFileSync(path, 'utf8')) as { storage?: { bucket_name?: string; aws_region?: string } };
    const name = outputs.storage?.bucket_name;
    if (!name) return null;
    return { bucket: name, region: outputs.storage?.aws_region || process.env.AWS_REGION || 'us-east-1' };
  } catch {
    return null;
  }
}

/** What this module needs of the AWS SDK, so the import can stay loose. */
interface S3Module {
  S3Client: new (config: { region: string }) => { send: (command: unknown) => Promise<unknown> };
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * The store, or null when there is nothing to talk to. The SDK is imported by a
 * name the bundler cannot see on purpose: a deployment that keeps attachments in
 * the database does not have to carry the dependency.
 */
export async function s3FileStore(): Promise<FileStore | null> {
  const config = filesBucketConfig();
  if (!config) return null;
  let sdk: S3Module;
  try {
    sdk = (await import(/* webpackIgnore: true */ ['@aws-sdk', 'client-s3'].join('/'))) as unknown as S3Module;
  } catch {
    console.warn('Attachments stay in the database: install @aws-sdk/client-s3 to use the S3 bucket.');
    return null;
  }
  const client = new sdk.S3Client({ region: config.region });
  return {
    description: `s3://${config.bucket}`,
    put: async (key, bytes, contentType) => {
      await client.send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    get: async (key) => {
      try {
        const response = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key })) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
        const body = response.Body;
        if (!body?.transformToByteArray) return null;
        return await body.transformToByteArray();
      } catch {
        return null;
      }
    },
    delete: async (key) => {
      await client.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => undefined);
    },
  };
}
