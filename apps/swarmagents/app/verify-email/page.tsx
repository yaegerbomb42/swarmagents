import VerifyForm from "./verify-form";

export const dynamic = "force-dynamic";

/**
 * Email-verification landing page (FIX-44). The verification email links
 * here with ?token=<ev1.…>; the form POSTs it to
 * /api/email-verification/confirm. The token is the credential — this
 * page is public (see middleware PUBLIC) and never renders account
 * details. Signed-in users who lost the email can resend from here.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <VerifyForm token={typeof token === "string" ? token : ""} />;
}
