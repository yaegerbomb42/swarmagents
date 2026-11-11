import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const DEFAULT_ENDPOINT = 'https://528c0128f84684b55dcd901251ef766b.r2.cloudflarestorage.com';
const DEFAULT_BUCKET = 'swarmagents-datasets';
/** Short-lived paid download links (seconds). */
const PRESIGN_EXPIRES_SECONDS = 15 * 60;

export type PresignResult =
  | { ok: true; url: string; expiresIn: number }
  | { ok: false; reason: string };

function r2CredentialsConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCESS_KEY_ID?.trim() &&
      process.env.R2_SECRET_ACCESS_KEY?.trim() &&
      (process.env.R2_S3_ENDPOINT?.trim() || process.env.R2_ACCOUNT_ID?.trim())
  );
}

function getR2Client(): S3Client | null {
  if (!r2CredentialsConfigured()) return null;

  const accessKeyId = process.env.R2_ACCESS_KEY_ID!.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!.trim();
  const endpoint =
    process.env.R2_S3_ENDPOINT?.trim() ||
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
      : DEFAULT_ENDPOINT);

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

/**
 * Create a short-lived presigned GET URL for a dataset archive object in R2.
 * Returns null-ish failure when S3 credentials are not configured.
 */
export async function createDatasetPresignedGetUrl(
  objectKey: string,
  expiresIn: number = PRESIGN_EXPIRES_SECONDS
): Promise<PresignResult> {
  const client = getR2Client();
  if (!client) {
    return { ok: false, reason: 'r2_credentials_missing' };
  }

  const bucket = process.env.R2_BUCKET?.trim() || DEFAULT_BUCKET;
  const key = objectKey.replace(/^\/+/, '');

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${key.split('/').pop() || key}"`,
    });
    const url = await getSignedUrl(client, command, { expiresIn });
    return { ok: true, url, expiresIn };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'presign_failed';
    console.error('R2 presign error:', message);
    return { ok: false, reason: 'presign_failed' };
  }
}

export function getPublicR2FallbackBase(): string | null {
  const base =
    process.env.R2_DATASETS_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_R2_DATASETS_BASE_URL?.trim() ||
    '';
  if (!base) return null;
  return base.replace(/\/+$/, '');
}
