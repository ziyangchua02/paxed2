import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import helmet from "helmet";

import { registerDriveApiRoutes } from "./drive-api.js";
import { registerMapApiRoutes } from "./map-api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");
const publicDirectory = path.join(projectRoot, "public");
const indexFile = path.join(publicDirectory, "index.html");

/**
 * Create the static Express app that serves the landing page and its assets.
 */
export function createApp() {
  const app = express();

  app.use(
    helmet({
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      referrerPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: [
            "'self'",
            "https://identitytoolkit.googleapis.com",
            "https://securetoken.googleapis.com",
            "https://firebaseinstallations.googleapis.com",
            "https://apis.google.com",
            "https://www.googleapis.com",
            "https://*.firebaseapp.com",
            "https://*.web.app"
          ],
          fontSrc: ["'self'"],
          frameSrc: [
            "'self'",
            "https://accounts.google.com",
            "https://apis.google.com",
            "https://*.firebaseapp.com",
            "https://*.web.app"
          ],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: [
            "'self'",
            "data:",
            "https://unpkg.com",
            "https://tile.openstreetmap.org",
            "https://*.tile.openstreetmap.org"
          ],
          objectSrc: ["'none'"],
          scriptSrc: [
            "'self'",
            "https://www.gstatic.com",
            "https://apis.google.com",
            "https://www.googleapis.com",
            "https://unpkg.com"
          ],
          styleSrc: ["'self'", "https://unpkg.com"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

  // OpenStreetMap tiles require a Referer header; set it explicitly.
  app.use((_request, response, next) => {
    response.setHeader("Referrer-Policy", "origin");
    next();
  });

  registerMapApiRoutes(app);
  registerDriveApiRoutes(app);

  app.disable("x-powered-by");
  app.use(express.static(publicDirectory, { extensions: ["html"] }));

  /**
   * Serve the single landing page for any direct browser request.
   */
  app.get(/.*/, (_request, response) => {
    response.sendFile(indexFile);
  });

  app.locals.closeResources = () => {};

  return app;
}
