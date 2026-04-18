import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import helmet from "helmet";

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
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

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
