import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";

let application;
let server;
let baseUrl;

test.before(async () => {
  application = createApp();
  server = application.listen(0);

  await new Promise((resolve) => {
    server.once("listening", resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  application.locals.closeResources();
});

test("GET / returns the landing page shell", async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Crowd intelligence/);
  assert.equal(html.includes("Contact sales"), true);
});

test("GET / sends the expected security headers", async () => {
  const response = await fetch(baseUrl);

  assert.equal(
    response.headers.get("content-security-policy")?.includes("script-src 'self'"),
    true
  );
  assert.equal(response.headers.get("x-powered-by"), null);
});
