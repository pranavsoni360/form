const { createServer } = require("https");
const { parse } = require("url");
const next = require("next");
const fs = require("fs");

const app = next({ dev: false });
const handle = app.getRequestHandler();
const port = 3001;

const httpsOptions = {
  key: fs.readFileSync("/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/fullchain.pem"),
};

app.prepare().then(() => {
  createServer(httpsOptions, (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(port, "0.0.0.0", () => {
    console.log(`> HTTPS server running on https://0.0.0.0:${port}`);
  });
});
