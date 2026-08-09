import assert from "node:assert/strict";
import test from "node:test";

import {parseProxyArgs, targetPort} from "../frappe-dev-reverse-proxy.mjs";

test("development proxy has isolated deterministic ports", () => {
  assert.deepEqual(parseProxyArgs([]), {listen: 8004, web: 8005, socketio: 9004});
  assert.deepEqual(parseProxyArgs(["--listen", "8200", "--web", "8201", "--socketio", "9200"]), {listen: 8200, web: 8201, socketio: 9200});
  assert.throws(() => parseProxyArgs(["--listen", "8004", "--web", "8004"]), /unique/);
  assert.throws(() => parseProxyArgs(["--listen", "80"]), /Invalid/);
});

test("only the Socket.IO path is routed away from the Frappe web service", () => {
  const ports = {listen: 8004, web: 8005, socketio: 9004};
  assert.equal(targetPort("/socket.io/?EIO=4", ports), 9004);
  assert.equal(targetPort("/api/method/ping", ports), 8005);
  assert.equal(targetPort("/desk", ports), 8005);
  assert.equal(targetPort("https://evil.invalid/socket.io/", ports), 8005);
});
