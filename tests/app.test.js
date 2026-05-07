import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

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
  assert.match(html, /workspace-view-libraries/);
  assert.match(html, /workspace-view-rooms/);
  assert.match(html, /workspace-rooms-map/);
  assert.match(html, /workspace-libraries-grid/);
});

test("GET /api/map/health returns map API status", async () => {
  const response = await fetch(`${baseUrl}/api/map/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.services), true);
  assert.equal(typeof payload.tutorialRooms, "number");
});

test("GET /api/map/tutorial-rooms returns MazeMap-backed room map data", async () => {
  const response = await fetch(`${baseUrl}/api/map/tutorial-rooms`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.dataProvider, "mazemap-search");
  assert.equal(payload.mapProvider, "mazemap-embedded");
  assert.match(payload.source, /^mazemap-/);
  assert.equal(Array.isArray(payload.rooms), true);
  assert.equal(payload.rooms.length >= 10, true);

  const sampleRoom = payload.rooms.find((room) => room.mazeMapUrl);

  assert.equal(typeof sampleRoom.id, "string");
  assert.equal(typeof sampleRoom.code, "string");
  assert.equal(typeof sampleRoom.name, "string");
  assert.equal(typeof sampleRoom.building, "string");
  assert.equal(typeof sampleRoom.lat, "number");
  assert.equal(typeof sampleRoom.lng, "number");
  assert.match(sampleRoom.mazeMapUrl, /https:\/\/use\.mazemap\.com\//);
  assert.match(sampleRoom.mazeMapNavigationUrl, /desttype=/);
});

test("GET /api/map/tutorial-rooms/directions returns walking route to a tutorial room", async () => {
  const roomsResponse = await fetch(`${baseUrl}/api/map/tutorial-rooms`);
  const roomsPayload = await roomsResponse.json();
  const roomId = encodeURIComponent(roomsPayload.rooms[0].id);
  const response = await fetch(
    `${baseUrl}/api/map/tutorial-rooms/directions?roomId=${roomId}&fromLat=1.345640&fromLng=103.680780`
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, "straight-line-campus-walk");
  assert.equal(Array.isArray(payload.geometry), true);
  assert.equal(payload.geometry.length, 2);
  assert.equal(typeof payload.distanceMeters, "number");
  assert.equal(typeof payload.durationSeconds, "number");
  assert.match(payload.mazeMapNavigationUrl, /starttype=point/);
  assert.match(payload.mazeMapNavigationUrl, /desttype=/);
  assert.match(payload.mazeMapUrl, /https:\/\/use\.mazemap\.com\//);
  assert.match(payload.googleMapsUrl, /https:\/\/www\.google\.com\/maps\/dir/);
});

test("GET /api/drive/health returns drive API status", async () => {
  const response = await fetch(`${baseUrl}/api/drive/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.country, "SG");
  assert.equal(typeof payload.defaults?.radiusMeters, "number");
});

test("GET /api/weather/health returns weather API status", async () => {
  const response = await fetch(`${baseUrl}/api/weather/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.country, "SG");
  assert.equal(typeof payload.defaults?.cacheTtlMs, "number");
});

test("GET /api/libraries/health returns library API status", async () => {
  const response = await fetch(`${baseUrl}/api/libraries/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "mock");
  assert.equal(payload.prototype, true);
  assert.equal(typeof payload.libraries, "number");
});

test("GET /api/libraries/occupancy returns mock library seat data", async () => {
  const response = await fetch(`${baseUrl}/api/libraries/occupancy`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "mock");
  assert.equal(payload.prototype, true);
  assert.equal(Array.isArray(payload.libraries), true);
  assert.equal(payload.libraries.length >= 7, true);

  const leeWeeNamLibrary = payload.libraries.find(
    (library) => library.id === "lee-wee-nam-library"
  );

  assert.equal(leeWeeNamLibrary.name, "Lee Wee Nam Library");
  assert.equal(typeof leeWeeNamLibrary.totalSeats, "number");
  assert.equal(typeof leeWeeNamLibrary.occupiedSeats, "number");
  assert.equal(typeof leeWeeNamLibrary.availableSeats, "number");
  assert.equal(typeof leeWeeNamLibrary.occupancyRate, "number");
  assert.equal(typeof leeWeeNamLibrary.lastUpdated, "string");
});

test("Vercel serverless API entrypoints cover workspace API namespaces", () => {
  for (const namespace of ["drive", "libraries", "map", "weather"]) {
    const entrypointPath = path.join("api", namespace, "[...route].js");

    assert.equal(
      existsSync(entrypointPath),
      true,
      `${entrypointPath} should exist for Vercel production routing`
    );
  }
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

test("GET /workspace CSP allows embedded MazeMap room navigation", async () => {
  const response = await fetch(`${baseUrl}/workspace`);
  const cspHeader = response.headers.get("content-security-policy") ?? "";

  assert.match(cspHeader, /frame-src[^;]*https:\/\/use\.mazemap\.com/);
});
