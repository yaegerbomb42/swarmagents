import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

const PUBLIC_ORIGIN = "https://swarmagents.codes";

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function parseSignedRequest(
  signedRequest: string,
  secret: string,
): { user_id?: string } | null {
  const [sigB64, payloadB64] = signedRequest.split(".");
  if (!sigB64 || !payloadB64) return null;
  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  const given = b64urlDecode(sigB64);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    return JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as {
      user_id?: string;
    };
  } catch {
    return null;
  }
}

function confirmationPayload(code: string) {
  return {
    url: `${PUBLIC_ORIGIN}/data-deletion?code=${encodeURIComponent(code)}`,
    confirmation_code: code,
  };
}

/** Facebook probes this URL with GET; the instructions page is /data-deletion. */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    instructions: `${PUBLIC_ORIGIN}/data-deletion`,
    callback: `${PUBLIC_ORIGIN}/facebook/data-deletion`,
  });
}

/** Facebook Login data-deletion callback (POST signed_request). */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  let signedRequest = "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      signed_request?: string;
    };
    signedRequest = body.signed_request ?? "";
  } else {
    const form = await request.formData().catch(() => null);
    const fromForm = form?.get("signed_request");
    signedRequest = typeof fromForm === "string" ? fromForm : "";
  }

  const secret = process.env.FACEBOOK_APP_SECRET ?? "";
  const parsed = signedRequest && secret
    ? parseSignedRequest(signedRequest, secret)
    : null;
  const code = randomBytes(12).toString("hex");
  if (parsed?.user_id) {
    console.info("[facebook-data-deletion]", {
      facebook_user_id: parsed.user_id,
      confirmation_code: code,
    });
  } else if (signedRequest) {
    console.info("[facebook-data-deletion] unverified signed_request", {
      confirmation_code: code,
      has_secret: Boolean(secret),
    });
  }

  return NextResponse.json(confirmationPayload(code));
}
