import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/**
 * Serves the built client: `/` is index.html, `/assets/<name>` a file from
 * assets/. Nothing else on disk is reachable: an asset name must be one plain
 * file name after decoding, so `..`, slashes (also percent-encoded ones) and
 * dot files are refused before any path is built.
 */

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function plain(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cacheControl: string,
): Promise<boolean> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      return false;
    }
    size = info.size;
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": size,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    // A read error after the headers went out (the file deleted meanwhile)
    // can only end the response; unhandled, it would crash the server.
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  }
  return true;
}

/** Answers the request if it is for the client; returns false otherwise. */
export async function serveClient(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  clientDir: string,
): Promise<boolean> {
  const isIndex = pathname === "/";
  if (!isIndex && !pathname.startsWith("/assets/")) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    plain(res, 405, "method not allowed\n", { Allow: "GET, HEAD" });
    return true;
  }
  if (isIndex) {
    // Revalidated every time: it names the current hashed assets.
    if (!(await sendFile(req, res, path.join(clientDir, "index.html"), "no-cache"))) {
      plain(res, 503, "the client is not built (npm run build)\n");
    }
    return true;
  }
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice("/assets/".length));
  } catch {
    plain(res, 400, "bad percent-encoding\n");
    return true;
  }
  const assets = path.join(clientDir, "assets");
  const file = path.join(assets, name);
  // The name check is the guard; the dirname check is a second one, in case
  // the first is ever loosened.
  const found =
    ASSET_NAME.test(name) &&
    path.dirname(file) === assets &&
    // Hashed names never change content, so they can be cached for good.
    (await sendFile(req, res, file, "public, max-age=31536000, immutable"));
  if (!found) {
    plain(res, 404, "not found\n");
  }
  return true;
}
