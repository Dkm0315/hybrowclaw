#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import {pathToFileURL} from "node:url";

export function parseProxyArgs(argv) {
  const values = {listen: 8004, web: 8005, socketio: 9004};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    if (!(name in values) || !argv[index + 1]) throw new Error(`Unknown or incomplete option: ${argv[index] || ""}`);
    const port = Number(argv[index + 1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${name} port`);
    values[name] = port;
  }
  if (new Set(Object.values(values)).size !== 3) throw new Error("Proxy ports must be unique");
  return values;
}

export function targetPort(pathname, ports) {
  return String(pathname || "").startsWith("/socket.io/") ? ports.socketio : ports.web;
}

export function startProxy(ports) {
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: targetPort(request.url, ports),
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, {"content-type": "text/plain; charset=utf-8"});
      response.end("Upstream unavailable");
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(targetPort(request.url, ports), "127.0.0.1", () => {
      const headers = Object.entries(request.headers)
        .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`])
        .join("\r\n");
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => socket.destroy();
    upstream.on("error", close);
    socket.on("error", () => upstream.destroy());
  });

  server.listen(ports.listen, "127.0.0.1");
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ports = parseProxyArgs(process.argv.slice(2));
  const server = startProxy(ports);
  server.on("listening", () => process.stdout.write(`Frappe development proxy listening on 127.0.0.1:${ports.listen}\n`));
}
