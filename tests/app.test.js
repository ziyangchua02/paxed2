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

test("GET /auth serves the authentication page", async () => {
  const response = await fetch(`${baseUrl}/auth`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(html.includes("auth-map"), false);
  assert.match(html, /Continue with Google/);
  assert.match(html, /Sign in with email/);
  assert.match(html, /Sign Up/);
});

test("GET /workspace serves the signed-in workspace page", async () => {
  const response = await fetch(`${baseUrl}/workspace`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /workspace-map/);
  assert.match(html, /workspace-stage/);
  assert.match(html, /workspace-signout/);
});

test("GET /api/map/health returns map API status", async () => {
  const response = await fetch(`${baseUrl}/api/map/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.services), true);
});

test("GET /api/drive/health returns drive API status", async () => {
  const response = await fetch(`${baseUrl}/api/drive/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.country, "SG");
  assert.equal(typeof payload.defaults?.radiusMeters, "number");
});

test("GET / sends the expected security headers", async () => {
  const response = await fetch(baseUrl);

  assert.equal(
    response.headers.get("content-security-policy")?.includes("script-src 'self'"),
    true
  );
  assert.equal(response.headers.get("x-powered-by"), null);
});

test("GET / CSP allows Firebase popup auth endpoints", async () => {
  const response = await fetch(baseUrl);
  const cspHeader = response.headers.get("content-security-policy") ?? "";

  assert.match(cspHeader, /script-src[^;]*https:\/\/www\.gstatic\.com/);
  assert.match(cspHeader, /script-src[^;]*https:\/\/apis\.google\.com/);
  assert.match(cspHeader, /frame-src[^;]*https:\/\/accounts\.google\.com/);
  assert.match(cspHeader, /frame-src[^;]*https:\/\/apis\.google\.com/);
  assert.match(
    cspHeader,
    /connect-src[^;]*https:\/\/identitytoolkit\.googleapis\.com/
  );
});

test("GET / CSP allows Leaflet and OpenStreetMap map assets", async () => {
  const response = await fetch(`${baseUrl}/auth`);
  const cspHeader = response.headers.get("content-security-policy") ?? "";

  assert.match(cspHeader, /script-src[^;]*https:\/\/unpkg\.com/);
  assert.match(cspHeader, /style-src[^;]*https:\/\/unpkg\.com/);
  assert.match(cspHeader, /img-src[^;]*https:\/\/tile\.openstreetmap\.org/);
});
