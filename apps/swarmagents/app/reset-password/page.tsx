import ResetForm from "./reset-form";

export const dynamic = "force-dynamic";

/**
 * Password-reset landing page (FIX-39). The reset email links here with
 * ?token=<pr1.…>; the form POSTs it to /api/password-reset/confirm with
 * the new password. The token is the credential — this page is public
 * (see middleware PUBLIC) and never renders account details.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ResetForm token={typeof token === "string" ? token : ""} />;
}
