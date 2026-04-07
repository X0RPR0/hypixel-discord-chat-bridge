const config = require("../../config.json");
const WebSocket = require("ws");
const http = require("http");

class WebServer {
  constructor(bot) {
    this.bot = bot;
    this.port = config.web.port;
    this.start = Date.now();
  }

  async connect() {
    if (config.web.enabled === false) return;

    const server = http.createServer();
    const wss = new WebSocket.Server({ noServer: true });

    wss.on("connection", (ws) => {
      console.web("Client has connected to the server.");
      ws.on("message", (message) => {
        let parsed = null;
        try {
          const raw = typeof message === "string" ? message : message?.toString?.("utf8");
          if (!raw || raw.trim().length === 0) return;
          parsed = JSON.parse(raw);
        } catch {
          console.warn("WebSocket message parse failed: invalid JSON payload.");
          return;
        }

        if (!parsed || typeof parsed !== "object") {
          return;
        }

        if (parsed.type === "message" && parsed.token === config.web.token && parsed.data) {
          console.web(`Received: ${JSON.stringify(parsed)}`);
          this.bot?.chat(parsed.data);
        }
      });

      this.bot?.on("message", (message) => {
        ws.send(JSON.stringify(message));
      });
    });

    server.on("upgrade", (request, socket, head) => {
      if (request.url === "/message") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      }
    });

    server.listen(this.port, () => {
      console.web(`WebSocket running at http://localhost:${this.port}/`);
    });

    server.on("request", (req, res) => {
      if (req.url === "/uptime") {
        res.end(
          JSON.stringify({
            success: true,
            uptime: Date.now() - this.start
          })
        );
      } else {
        res.end(
          JSON.stringify({
            success: false,
            error: "Invalid route"
          })
        );
      }
    });
  }
}

module.exports = WebServer;
