import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { DATASET_PRODUCTS } from '@/lib/datasetPurchases';
import {
  isValidCheckoutSessionId,
  verifyDatasetCheckoutSession,
} from '@/lib/datasetStripe';
import {
  createDatasetPresignedGetUrl,
  getPublicR2FallbackBase,
} from '@/lib/datasetR2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sku = searchParams.get('sku') || 'master-210k';
  const token = searchParams.get('token') || '';
  const sessionId = searchParams.get('session_id') || '';

  // Paid-only gate: require Stripe checkout session before any R2 redirect / stream
  if (!sessionId) {
    return NextResponse.json(
      {
        error: 'Payment required',
        code: 'missing_session',
        message: 'Provide session_id from a completed Stripe Checkout (cs_live_ / cs_test_).',
        support: 'james@swarmagents.codes',
      },
      { status: 401 }
    );
  }

  if (!isValidCheckoutSessionId(sessionId)) {
    return NextResponse.json(
      {
        error: 'Invalid session',
        code: 'invalid_session',
        message: 'session_id must start with cs_live_ or cs_test_.',
        support: 'james@swarmagents.codes',
      },
      { status: 400 }
    );
  }

  const verification = await verifyDatasetCheckoutSession(sessionId, sku);
  if (!verification.ok) {
    const errVerif = verification as { ok: false; paid: boolean; sku?: string; error: string; status: number };
    const status = errVerif.status === 400 ? 400 : errVerif.status === 503 ? 503 : 402;
    return NextResponse.json(
      {
        error: errVerif.error || 'Payment not verified',
        code: 'payment_unverified',
        paid: errVerif.paid,
        sku: errVerif.sku || sku,
        support: 'james@swarmagents.codes',
      },
      { status }
    );
  }

  const product = DATASET_PRODUCTS[verification.sku] || DATASET_PRODUCTS[sku] || DATASET_PRODUCTS['master-210k'];
  const fileName = product.archiveFileName;

  // Optional token reserved for later fulfillment tokens (ignored for now if present)
  void token;

  // 0. Preferred: short-lived R2/S3 presigned GET (private-bucket ready)
  const presigned = await createDatasetPresignedGetUrl(fileName);
  if (presigned.ok) {
    return NextResponse.redirect(presigned.url, 302);
  }

  // 1. LAST RESORT: public R2 base URL only if credentials missing / presign failed
  const r2PublicBase = getPublicR2FallbackBase();
  if (r2PublicBase) {
    const reason = !presigned.ok ? (presigned as { ok: false; reason: string }).reason : 'unknown';
    console.warn(
      `dataset download using public R2 fallback (${reason}) for sku=${product.sku}`
    );
    return NextResponse.redirect(`${r2PublicBase}/${fileName}`, 302);
  }

  // 2. Local disk stream with Range support
  const localDiskCandidates = [
    path.join('/app/storage', fileName),
    path.join(process.cwd(), 'storage', fileName),
    path.join('/home/ubuntu/infra/landing-pages/public/yaeger-info/server/storage', fileName),
    path.join('/home/ubuntu/infra/landing-pages/public/swarmagents/dashboard/storage', fileName),
    path.join('/Users/yaeger/Desktop/LAMBO_ENTERPRISE_DATASET_SUITE/hf_multi_previews', fileName),
  ];

  const rangeHeader = request.headers.get('range');

  for (const diskPath of localDiskCandidates) {
    if (fs.existsSync(diskPath)) {
      try {
        const stats = fs.statSync(diskPath);
        const totalSize = stats.size;

        if (rangeHeader && rangeHeader.startsWith('bytes=')) {
          const parts = rangeHeader.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

          if (!isNaN(start) && start < totalSize) {
            const safeEnd = Math.min(end, totalSize - 1);
            const chunkLength = safeEnd - start + 1;
            const nodeStream = fs.createReadStream(diskPath, { start, end: safeEnd });
            const webStream = Readable.toWeb(nodeStream);

            return new NextResponse(webStream as BodyInit, {
              status: 206,
              headers: {
                'Content-Type': 'application/gzip',
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Content-Range': `bytes ${start}-${safeEnd}/${totalSize}`,
                'Content-Length': chunkLength.toString(),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'private, no-store',
              },
            });
          }
        }

        const nodeStream = fs.createReadStream(diskPath);
        const webStream = Readable.toWeb(nodeStream);

        return new NextResponse(webStream as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': totalSize.toString(),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
          },
        });
      } catch (err) {
        console.error(`Error streaming from ${diskPath}:`, err);
      }
    }
  }

  // 3. Fallback to candidate storage servers
  const candidateUrls = [
    `http://yaeger-info-server:3000/api/download?sku=${encodeURIComponent(product.sku)}&token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`,
    `http://localhost:3000/api/download?sku=${encodeURIComponent(product.sku)}&token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`,
  ];

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'SwarmAgents-Download-Client/1.0' } });
      if (response.ok && response.body) {
        return new NextResponse(response.body, {
          status: 200,
          headers: {
            'Content-Type': response.headers.get('Content-Type') || 'application/gzip',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store, must-revalidate',
          },
        });
      }
    } catch {
      // Continue
    }
  }

  return NextResponse.json(
    {
      error: 'Dataset payload currently provisioning or unavailable on storage mount',
      sku: product.sku,
      title: product.title,
      support: 'james@swarmagents.codes',
    },
    { status: 404 }
  );
}
