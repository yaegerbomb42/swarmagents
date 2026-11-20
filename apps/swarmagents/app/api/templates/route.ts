/**
 * The template gallery, as JSON.
 *
 * GET /api/templates -> {templates, categories}
 *
 * The catalog is static content that ships with the app, so this route is a
 * plain read: it exists so the browser bundle does not have to carry 60
 * written prompts. It is still behind the usual sign-in gate (the middleware
 * protects every /api path), and nothing per-account is stored or returned.
 */

import { NextResponse } from "next/server";
import { CATEGORY_INFO, TEMPLATES } from "../../../lib/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    templates: TEMPLATES,
    categories: CATEGORY_INFO.map((info) => ({
      id: info.id,
      label: info.label,
      blurb: info.blurb,
    })),
  });
}
