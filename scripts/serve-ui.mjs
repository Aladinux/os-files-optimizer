// Sert le dossier src/ pour mettre au point l'interface dans un navigateur
// (avec les données factices de dev-mock.js) : node scripts/serve-ui.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path === "/" || path === "\\" ? "index.html" : path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(4173, "localhost", () => console.log("http://localhost:4173"));
