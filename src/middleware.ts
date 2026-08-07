import { type NextRequest, NextResponse } from "next/server";

import { validatedRedirectPath } from "./server/http/redirect-path";
import { uiLocaleForPathname } from "./server/http/ui-locale";

const SESSION_COOKIE_NAME = "dnd_firegory_session";

const PUBLIC_PATHS = new Set([
  "/login",
  "/register",
  "/_next",
  "/favicon.ico",
]);

const WEBHOOK_PATHS = new Set([
  "/api/telegram/webhook",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/login") || pathname.startsWith("/register")) return true;
  return false;
}

function isWebhook(pathname: string): boolean {
  return WEBHOOK_PATHS.has(pathname);
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-dnd-ui-language", uiLocaleForPathname(pathname));
  requestHeaders.set("x-dnd-request-path", validatedRedirectPath(`${pathname}${request.nextUrl.search}`));

  if (isPublic(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (isWebhook(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  // API routes without auth: return 401 JSON instead of redirecting to /login.
  // Client-side fetch() follows redirects silently and tries to parse HTML as JSON,
  // which causes SyntaxError and confusing "Network error" messages.
  if (!sessionToken && isApiRoute(pathname)) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  if (!sessionToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", validatedRedirectPath(`${pathname}${request.nextUrl.search}`));
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, robots.txt, sitemap.xml
     */
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)",
  ],
};
