export function getApiBaseUrl(): string {
  // Keep browser requests same-origin in both local Vite and Vercel. Vite
  // proxies /api locally and Vercel rewrites /api to the Worker in production;
  // this avoids third-party-cookie blocking between vercel.app and workers.dev.
  return "";
}
