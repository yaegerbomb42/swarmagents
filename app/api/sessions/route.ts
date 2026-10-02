import { scoped } from "@/lib/auth";
import { createSession, listSessions } from "@/lib/store";

export const dynamic = "force-dynamic";

async function getHandler() {
  return Response.json({ sessions: listSessions() });
}

async function postHandler() {
  return Response.json({ session: createSession() });
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const GET = scoped(getHandler);
export const POST = scoped(postHandler);
