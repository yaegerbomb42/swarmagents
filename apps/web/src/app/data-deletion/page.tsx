import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data deletion request · swarmagents.codes",
  description:
    "How to request deletion of account data and conversation history on swarmagents.codes.",
  robots: { index: true, follow: true },
};

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-[#050508] px-6 py-16 text-cyan-100">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-4 text-3xl font-semibold">Delete your data</h1>
        <p className="mb-6 text-cyan-100/70">
          If you signed in to swarmagents.codes using Facebook, Google, or
          email, you can request that we delete your account and associated
          data at any time.
        </p>

        <h2 className="mb-2 mt-8 text-xl font-semibold">What gets deleted</h2>
        <ul className="mb-6 list-disc space-y-1 pl-6 text-cyan-100/80">
          <li>Firebase Auth account (email, OAuth provider links)</li>
          <li>Engine-side user row and billing ledger</li>
          <li>Task decompositions, run history, and saved artifacts</li>
          <li>Cognitive memory entries (tribal, episodic, semantic)</li>
          <li>Support- and billing-related messages</li>
        </ul>

        <h2 className="mb-2 mt-8 text-xl font-semibold">How to request deletion</h2>
        <p className="mb-4 text-cyan-100/80">
          The fastest way to delete your data is from inside the app:
        </p>
        <ol className="mb-6 list-decimal space-y-1 pl-6 text-cyan-100/80">
          <li>
            Sign in, then go to{" "}
            <Link href="/settings" className="text-cyan-300 underline">
              Settings
            </Link>
            .
          </li>
          <li>Scroll to <em>Danger zone</em> and click <em>Delete account</em>.</li>
          <li>Confirm the prompt. Deletion is immediate and irreversible.</li>
        </ol>
        <p className="mb-6 text-cyan-100/80">
          If you can&apos;t sign in (lost access, broken OAuth, etc.), email
          us from the address tied to the account with subject{" "}
          <code className="rounded bg-cyan-950/40 px-1 py-0.5 text-cyan-200">
            DATA DELETION REQUEST
          </code>{" "}
          and we&apos;ll handle it within 30 days:
        </p>
        <p className="mb-8">
          <a
            href="mailto:privacy@swarmagents.codes?subject=DATA%20DELETION%20REQUEST"
            className="rounded-md bg-cyan-500 px-4 py-2 font-semibold text-black hover:bg-cyan-400"
          >
            privacy@swarmagents.codes
          </a>
        </p>

        <h2 className="mb-2 mt-8 text-xl font-semibold">Facebook users</h2>
        <p className="mb-6 text-cyan-100/80">
          Paste this URL in Meta for Developers → Settings → Basic →{" "}
          <strong>User data deletion</strong>:{" "}
          <code className="rounded bg-cyan-950/40 px-1 py-0.5 text-cyan-200">
            https://swarmagents.codes/data-deletion
          </code>
          . If Facebook Login asks for a callback URL, use{" "}
          <code className="rounded bg-cyan-950/40 px-1 py-0.5 text-cyan-200">
            https://swarmagents.codes/facebook/data-deletion
          </code>
          . After you remove the app from Facebook Settings, we receive that
          callback and delete linked SwarmAgents data; you can also email us
          with the confirmation code shown on this page.
        </p>

        <h2 className="mb-2 mt-8 text-xl font-semibold">Related</h2>
        <ul className="list-disc space-y-1 pl-6 text-cyan-100/80">
          <li>
            <Link href="/privacy" className="text-cyan-300 underline">
              Privacy policy
            </Link>
          </li>
          <li>
            <Link href="/terms" className="text-cyan-300 underline">
              Terms of service
            </Link>
          </li>
        </ul>
      </div>
    </main>
  );
}
