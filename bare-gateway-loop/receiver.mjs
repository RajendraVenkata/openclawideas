// Tiny outbound receiver — logs whatever the webhook channel POSTs to it.
// Run with: npm run receiver   (listens on http://127.0.0.1:4001/receive)
import { createServer } from "node:http";

const PORT = 4001;

createServer((req, res) => {
  if (req.method === "POST" && (req.url ?? "").startsWith("/receive")) {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      console.log(`📨 outbound received: ${data}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, "127.0.0.1", () => {
  console.log(`receiver listening on http://127.0.0.1:${PORT}/receive`);
});
