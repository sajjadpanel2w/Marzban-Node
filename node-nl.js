"use strict";

// Railway location node for alirezapanel.
// Service start command: node node-nl.js
// Region: europe-west4-drams3a
// TCP Proxy application port: 10000
// This node dials the panel. It is not the official marzban-node image:
// Railway allows one public TCP port, and official Marzban nodes wait for
// the panel to dial two extra ports with a pasted certificate.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn } = require("child_process");

const LOCATION = {
  id: "nl",
  name: "هلند",
  city: "آمستردام",
  region: "europe-west4-drams3a",
  file: "node-nl.js",
};
const VERSION = "alireza-railway-node-1";
const XRAY_VERSION = "v26.3.27";
const XRAY_URL = "https://github.com/XTLS/Xray-core/releases/download/" + XRAY_VERSION + "/Xray-linux-64.zip";
const DATA = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data", LOCATION.id);
const XRAY_PORT = Number(process.env.XRAY_PORT || 10000);
const SYNC_MS = 15000;

function log(line) {
  process.stdout.write("[" + new Date().toISOString() + "] [" + LOCATION.id + "] " + line + "\n");
}

function download(url, redirects) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: { "user-agent": "alirezapanel-railway" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("دانلود Xray ناموفق: " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

function unzipEntry(buf, wanted) {
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const start = offset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    if (name === wanted || name.endsWith("/" + wanted)) {
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error("روش فشرده‌سازی Xray پشتیبانی نمی‌شود: " + method);
    }
    offset = start + compSize;
  }
  throw new Error("فایل " + wanted + " داخل بسته Xray پیدا نشد.");
}

async function ensureXray() {
  if (process.env.XRAY_BIN && fs.existsSync(process.env.XRAY_BIN)) return process.env.XRAY_BIN;
  const dest = path.join(DATA, "xray");
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000000) return dest;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Xray این بسته فقط لینوکس amd64 است. این محیط: " + process.platform + "/" + process.arch);
  }
  fs.mkdirSync(DATA, { recursive: true });
  log("Xray " + XRAY_VERSION + " دانلود می‌شود. این کار فقط بار اول است.");
  const zip = await download(XRAY_URL, 0);
  const bin = unzipEntry(zip, "xray");
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, bin, { mode: 0o755 });
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
  log("Xray آماده شد.");
  return dest;
}

function publicEndpoint() {
  const host = String(process.env.PUBLIC_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN || "").trim();
  const port = Number(process.env.PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT || 0);
  return { host, port: Number.isInteger(port) ? port : 0 };
}

function xrayConfig(reality, users) {
  return {
    log: { loglevel: "warning" },
    stats: {},
    api: { tag: "api", services: ["StatsService"] },
    policy: { levels: { "0": { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: 10085,
        protocol: "dokodemo-door",
        settings: { address: "127.0.0.1" },
        tag: "api",
      },
      {
        listen: "0.0.0.0",
        port: XRAY_PORT,
        protocol: "vless",
        tag: "in-" + LOCATION.id,
        settings: {
          decryption: "none",
          clients: users.map((user) => ({ id: user.id, email: user.id, flow: "xtls-rprx-vision" })),
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            show: false,
            dest: reality.dest,
            xver: 0,
            serverNames: [reality.sni],
            privateKey: reality.privateKey,
            shortIds: [reality.shortId],
          },
        },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
      },
    ],
    outbounds: [{ protocol: "freedom", tag: "direct" }],
    routing: { rules: [{ type: "field", inboundTag: ["api"], outboundTag: "api" }] },
  };
}

function parseStats(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : (parsed.stat || parsed.stats || []);
    const sums = {};
    for (const row of rows) {
      const name = String(row.name || "");
      const id = name.split(">>>")[1];
      if (!id) continue;
      sums[id] = (sums[id] || 0) + Number(row.value || 0);
    }
    return Object.keys(sums).map((id) => ({ id, bytes: sums[id] }));
  } catch (err) {
    return [];
  }
}

function queryUsage(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["api", "statsquery", "--server=127.0.0.1:10085", "-pattern", "user>>>"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve([]); }, 8000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => { clearTimeout(timer); resolve(parseStats(Buffer.concat(chunks).toString("utf8"))); });
  });
}

function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
        "x-node-token": token,
      },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error("پنل پاسخ " + res.statusCode + " داد: " + text.slice(0, 180)));
        try { resolve(JSON.parse(text)); }
        catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("اتصال به پنل طول کشید")));
    req.end(payload);
  });
}

function startHealth() {
  const port = Number(process.env.PORT || 0);
  if (!port || port === XRAY_PORT) return;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok " + LOCATION.id);
  });
  server.listen(port, "0.0.0.0", () => log("سلامت HTTP روی " + port));
}

async function main() {
  const panel = String(process.env.PANEL_URL || "").replace(/\/+$/, "");
  const token = process.env.NODE_TOKEN || "";
  if (!panel) {
    log("PANEL_URL خالی است. مثال: https://نام-دامنه-پنل");
    process.exit(1);
  }
  if (token.length < 16) {
    log("NODE_TOKEN باید همان مقدار پنل و حداقل ۱۶ حرف باشد.");
    process.exit(1);
  }
  if (!Number.isInteger(XRAY_PORT) || XRAY_PORT < 1 || XRAY_PORT > 65535) {
    log("XRAY_PORT نامعتبر است.");
    process.exit(1);
  }
  fs.mkdirSync(DATA, { recursive: true });
  log(LOCATION.name + " / " + LOCATION.city + " برای منطقه " + LOCATION.region);
  startHealth();
  let bin = "";
  let child = null;
  let sessionId = "";
  let configHash = "";
  const stopChild = () => {
    if (child && !child.killed) child.kill("SIGTERM");
  };
  process.on("SIGTERM", () => { stopChild(); process.exit(0); });
  process.on("SIGINT", () => { stopChild(); process.exit(0); });

  async function xrayUp(reality, users) {
    if (!bin) bin = await ensureXray();
    const config = xrayConfig(reality, users);
    const text = JSON.stringify(config);
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (hash === configHash && child && child.exitCode == null) return true;
    fs.writeFileSync(path.join(DATA, "config.json"), text);
    stopChild();
    sessionId = String(Date.now());
    child = spawn(bin, ["run", "-c", path.join(DATA, "config.json")], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code, signal) => {
      if (signal !== "SIGTERM") log("Xray بسته شد: " + (signal || code));
      if (child && child.exitCode != null) configHash = "";
    });
    configHash = hash;
    log("Xray برای " + users.length + " کاربر روی پورت داخلی " + XRAY_PORT + " بالا آمد.");
    return true;
  }

  let warnedProxy = false;
  function syncBody(endpoint, usage) {
    return {
      id: LOCATION.id,
      name: LOCATION.name,
      region: LOCATION.region,
      publicHost: endpoint.host,
      publicPort: endpoint.port,
      xray: !!(child && child.exitCode == null),
      sessionId,
      usage,
      version: VERSION,
    };
  }

  async function once() {
    const endpoint = publicEndpoint();
    if ((!endpoint.host || !endpoint.port) && !warnedProxy) {
      warnedProxy = true;
      log("TCP Proxy هنوز دیده نمی‌شود. در Railway برای این سرویس TCP Proxy بسازید و پورت داخلی را " + XRAY_PORT + " بگذارید، بعد Redeploy کنید.");
    }
    let usage = [];
    if (bin && child && child.exitCode == null) usage = await queryUsage(bin);
    const runningBefore = !!(child && child.exitCode == null);
    const response = await postJson(panel + "/api/node/sync", token, syncBody(endpoint, usage));
    await xrayUp(response.reality, response.users || []);
    const runningAfter = !!(child && child.exitCode == null);
    if (runningAfter !== runningBefore) {
      await postJson(panel + "/api/node/sync", token, syncBody(endpoint, usage));
    }
  }

  for (;;) {
    try {
      await once();
    } catch (err) {
      log("وصل نشد: " + err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, SYNC_MS));
  }
}

main();
