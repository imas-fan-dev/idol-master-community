import { isSensitiveRequestPath } from "@/middleware/static-path-policy";

export type FrontendRouteDecision =
  | { kind: "server" }
  | { kind: "frontend"; assetPath: string }
  | { kind: "not-found" };

export interface FrontendRouteRequest {
  method: string;
  pathname: string;
}

const SERVER_PREFIXES = [
  "/api",
  "/site-content",
  "/sites",
  "/image",
  "/icon",
  "/css",
  "/uploads",
  "/eventchronicle",
  "/assets/images/eventchronicle/events",
] as const;

const PRERENDERED_ROUTES: ReadonlyMap<string, string> = new Map([
  ["/account/login", "account/login/index.html"],
  ["/account/register", "account/register/index.html"],
  ["/about", "about/index.html"],
  ["/events", "events/index.html"],
  ["/recommendations", "recommendations/index.html"],
  ["/live", "live/index.html"],
  ["/community", "community/index.html"],
  ["/community/exchange", "community/exchange/index.html"],
  ["/community/cards", "community/cards/index.html"],
  ["/producer-map", "producer-map/index.html"],
  ["/works", "works/index.html"],
  ["/works/765", "works/765/index.html"],
  ["/works/cg", "works/cg/index.html"],
  ["/works/ml", "works/ml/index.html"],
  ["/works/sidem", "works/sidem/index.html"],
  ["/works/sc", "works/sc/index.html"],
  ["/works/gakuen", "works/gakuen/index.html"],
  ["/works/games", "works/games/index.html"],
  ["/works/wows", "works/wows/index.html"],
  ["/wiki", "wiki/index.html"],
  ["/wiki/modern", "wiki/modern/index.html"],
  ["/wiki/classic", "wiki/classic/index.html"],
  ["/story", "story/index.html"],
  ["/story/modern", "story/modern/index.html"],
  ["/story/classic", "story/classic/index.html"],
  ["/chronicle", "chronicle/index.html"],
] as const);

const SPA_FALLBACK = "__spa-fallback.html";

function requestPath(pathname: unknown): string | null {
  const value = String(pathname || "");
  const end = value.search(/[?#]/);
  const path = end === -1 ? value : value.slice(0, end);
  if (!path.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(path))
    return null;
  return path;
}

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isServerOwned(pathname: string): boolean {
  if (SERVER_PREFIXES.some((prefix) => hasPathPrefix(pathname, prefix)))
    return true;
  if (/^\/information\/[a-z0-9][a-z0-9_-]{7,63}\/content$/i.test(pathname))
    return true;
  return /^\/runninggame\/(?:Build|BuildMobile)\/[^/]+\.data$/.test(pathname);
}

function decodedSegments(pathname: string): string[] | null {
  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.some((segment) => segment.length === 0)) return null;

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[/\\\u0000-\u001f\u007f]/.test(segment)
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

export function resolveFrontendRoute(
  request: FrontendRouteRequest,
  frontendFiles: ReadonlySet<string>,
): FrontendRouteDecision {
  const pathname = requestPath(request.pathname);
  if (!pathname) return { kind: "not-found" };

  const method = String(request.method || "").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return { kind: "server" };

  // Server and security ownership always wins, including for non-navigation methods.
  if (isSensitiveRequestPath(pathname) || isServerOwned(pathname))
    return { kind: "server" };

  if (pathname === "/" || pathname === "/index.html") {
    return frontendFiles.has("index.html")
      ? { kind: "frontend", assetPath: "index.html" }
      : { kind: "not-found" };
  }

  const routePathname =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  const prerenderedAsset = PRERENDERED_ROUTES.get(routePathname);
  if (prerenderedAsset) {
    return frontendFiles.has(prerenderedAsset)
      ? { kind: "frontend", assetPath: prerenderedAsset }
      : { kind: "not-found" };
  }

  const segments = decodedSegments(routePathname);
  if (!segments) return { kind: "not-found" };

  const usesSpaFallback =
    (hasPathPrefix(routePathname, "/admin") && segments[0] === "admin") ||
    (hasPathPrefix(routePathname, "/information") &&
      segments[0] === "information" &&
      segments.length === 2) ||
    (hasPathPrefix(routePathname, "/chronicle") &&
      segments[0] === "chronicle" &&
      segments.length === 2) ||
    (routePathname === "/community/exchange/me" &&
      segments[0] === "community" &&
      segments[1] === "exchange" &&
      segments[2] === "me" &&
      segments.length === 3) ||
    (hasPathPrefix(routePathname, "/community/exchange/offices") &&
      segments[0] === "community" &&
      segments[1] === "exchange" &&
      segments[2] === "offices" &&
      segments.length === 4);
  if (usesSpaFallback) {
    return frontendFiles.has(SPA_FALLBACK)
      ? { kind: "frontend", assetPath: SPA_FALLBACK }
      : { kind: "not-found" };
  }

  if (routePathname !== pathname) return { kind: "not-found" };

  const assetPath = segments.join("/");
  return !assetPath.endsWith(".html") && frontendFiles.has(assetPath)
    ? { kind: "frontend", assetPath }
    : { kind: "not-found" };
}
