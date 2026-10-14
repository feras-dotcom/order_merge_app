import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname);
const publicRoot = resolve(root, "../public");
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const server = createServer((request, response) => {
  if (!request.url || !["GET", "HEAD"].includes(request.method || "")) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const url = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`,
  );
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const servesPublicAsset = pathname.startsWith("/brand/");
  const requestRoot = servesPublicAsset ? publicRoot : root;
  let candidate = resolve(requestRoot, `.${normalize(pathname)}`);
  if (!candidate.startsWith(requestRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    candidate = join(candidate, "index.html");
  }

  let status = 200;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    candidate = join(root, "404.html");
    status = 404;
  }

  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type":
      contentTypes[extname(candidate).toLowerCase()] ||
      "application/octet-stream",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(candidate).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MergeShip local preview: http://127.0.0.1:${port}`);
});
