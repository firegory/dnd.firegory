import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../../../server/auth/session";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  void user;
  void await params;
  return NextResponse.json(
    {
      error: "This destructive endpoint is retired. Archive the source from its detail page.",
      code: "SOURCE_DELETE_GONE",
    },
    { status: 410 },
  );
}
