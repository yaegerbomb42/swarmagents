import { createSession, listSessions } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ sessions: listSessions() });
}

export async function POST() {
  return Response.json({ session: createSession() });
}
