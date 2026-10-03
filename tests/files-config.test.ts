import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filesBucketConfig } from '../lib/server/files.js';

/**
 * Which bucket the attachments go to. It is read from the same
 * `amplify_outputs.json` the database details come from, so a deployment needs
 * no extra configuration — and a box without that file keeps its payloads in the
 * database rather than failing.
 */
const keys = ['RODEO_FILES_BUCKET', 'RODEO_FILES_REGION', 'RODEO_OUTPUTS', 'AWS_REGION'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const outputsFile = (contents: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'rodeo-outputs-')), 'amplify_outputs.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
};

describe('the attachment bucket', () => {
  it('comes from the environment when it is set', () => {
    process.env.RODEO_FILES_BUCKET = 'my-bucket';
    process.env.RODEO_FILES_REGION = 'eu-west-1';
    expect(filesBucketConfig()).toEqual({ bucket: 'my-bucket', region: 'eu-west-1' });
  });

  it('falls back to the deployment region for a bucket named by hand', () => {
    process.env.RODEO_FILES_BUCKET = 'my-bucket';
    delete process.env.RODEO_FILES_REGION;
    process.env.AWS_REGION = 'ap-south-1';
    expect(filesBucketConfig()).toEqual({ bucket: 'my-bucket', region: 'ap-south-1' });
  });

  it('reads the bucket the Amplify deployment made', () => {
    delete process.env.RODEO_FILES_BUCKET;
    process.env.RODEO_OUTPUTS = outputsFile({ storage: { bucket_name: 'amplify-rodeo-files', aws_region: 'ap-south-1' } });
    expect(filesBucketConfig()).toEqual({ bucket: 'amplify-rodeo-files', region: 'ap-south-1' });
  });

  it('says there is no bucket when the outputs carry no storage', () => {
    delete process.env.RODEO_FILES_BUCKET;
    process.env.RODEO_OUTPUTS = outputsFile({ auth: {}, custom: {} });
    expect(filesBucketConfig()).toBeNull();
  });

  it('says there is no bucket when there are no outputs at all', () => {
    delete process.env.RODEO_FILES_BUCKET;
    process.env.RODEO_OUTPUTS = join(tmpdir(), 'rodeo-outputs-does-not-exist', 'amplify_outputs.json');
    expect(filesBucketConfig()).toBeNull();
  });
});
