const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#15130f"/><path d="M32 8 53 20v24L32 56 11 44V20z" fill="#b4362d" stroke="#f0dfb9" stroke-width="3"/><path d="m32 16 6 11 12 2-9 8 2 12-11-6-11 6 2-12-9-8 12-2z" fill="#f0dfb9"/></svg>`;

export function GET(): Response {
  return new Response(FAVICON, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  });
}
