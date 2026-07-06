const { createServer } = require("https");
const { parse } = require("url");
const next = require("next");
const fs = require("fs");

const app = next({ dev: false });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT, 10) || 3001;

const httpsOptions = {
  key: fs.readFileSync("/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/fullchain.pem"),
};

app.prepare().then(() => {
  createServer(httpsOptions, (req, res) => {
    // This app has NO Next.js Server Actions (verified: zero "use server" in
    // the codebase). Internet bots probe public endpoints with bogus
    // `Next-Action` headers, which Next 14.1.0 turns into noisy
    // "Failed to find Server Action ... reading 'workers'" error logs. Since no
    // legitimate request ever carries this header, reject it early so the logs
    // stay clean and only surface real errors. Covers both nginx-fronted and
    // direct :3001 traffic. (RSC navigation uses RSC/Next-Router-* headers, not
    // Next-Action, so this never affects real page loads.)
    if (req.headers["next-action"]) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain");
      res.end("Bad Request");
      return;
    }
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(port, "0.0.0.0", () => {
    console.log(`> HTTPS server running on https://0.0.0.0:${port}`);
  });
});
