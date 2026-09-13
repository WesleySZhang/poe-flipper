import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE } from "@/lib/site-auth";

// This file is intentionally named proxy.ts, not middleware.ts - Next.js 16 deprecated and
// renamed the "middleware" file convention to "proxy" (same behavior, see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
export function proxy(request: NextRequest) {
  const isAuthed = request.cookies.get(AUTH_COOKIE_NAME)?.value === AUTH_COOKIE_VALUE;
  if (!isAuthed) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = {
  matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico).*)"],
};
