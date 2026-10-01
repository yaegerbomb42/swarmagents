import { session } from "@/lib/agent";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  session((await params).id)?.stop();
  return Response.json({ ok: true });
}
