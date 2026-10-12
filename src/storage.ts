import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, NoSuchKey,
} from '@aws-sdk/client-s3';
import { config } from './config';

// Submission screenshots live in the Garage bucket rather than on local disk, so
// they're still there after the worker moves to the other node. Keys are plain
// filenames ("<submission id>.webp", "<submission id>.orig.webp").

const s3 = new S3Client({
  endpoint: config.s3.endpoint || undefined,
  region: config.s3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  // Newer SDKs checksum every request by default; only send them where S3
  // requires one, as some S3-compatible servers reject the extra headers.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function mimeFor(key: string): string {
  return MIME_BY_EXT[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export async function putObject(key: string, data: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: key, Body: data, ContentType: mimeFor(key),
  }));
}

// The object's bytes, or null if there's no such key.
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
  } catch (e) {
    if (e instanceof NoSuchKey) return null;
    throw e;
  }
}

// Removes a key. Deleting a missing key is not an error in S3.
export async function deleteObject(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}
