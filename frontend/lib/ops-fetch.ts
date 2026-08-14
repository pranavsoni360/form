// lib/ops-fetch.ts — drop-in replacement for fetch() in the /ops/* console.
//
// The ops pages historically called fetch() with only `credentials:"include"`,
// which sends the (httpOnly) refresh cookie but NOT the access token — so the
// backend could not authenticate/scope the request. opsFetch attaches the admin
// access token as a Bearer header (merging any headers the caller passed) while
// preserving the fetch() contract: it returns the raw Response, so existing
// `res.ok` / `res.json()` handling keeps working unchanged.
import { API_URL } from "@/lib/api";
import { authHeader } from "@/lib/auth";

export function opsFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_URL}${path}`;
  return fetch(url, {
    ...options,
    credentials: "include",
    headers: authHeader("admin", (options.headers as Record<string, string>) || {}),
  });
}
