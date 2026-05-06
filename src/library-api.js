import { mockLibraryOccupancy } from "./data/mock-library-occupancy.js";

const LIBRARY_DATA_SOURCE = "mock";

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeLibraryOccupancy = (library) => {
  const totalSeats = Math.max(Number(library?.totalSeats) || 0, 0);
  const occupiedSeats = clampNumber(Number(library?.occupiedSeats) || 0, 0, totalSeats);
  const availableSeats = clampNumber(
    Number.isFinite(Number(library?.availableSeats))
      ? Number(library.availableSeats)
      : totalSeats - occupiedSeats,
    0,
    totalSeats
  );
  const occupancyRate = clampNumber(
    Number.isFinite(Number(library?.occupancyRate))
      ? Number(library.occupancyRate)
      : Math.round((occupiedSeats / Math.max(totalSeats, 1)) * 100),
    0,
    100
  );

  return {
    id: String(library?.id || "").trim(),
    name: String(library?.name || "").trim(),
    location: String(library?.location || "").trim(),
    totalSeats,
    occupiedSeats,
    availableSeats,
    occupancyRate,
    lastUpdated: String(library?.lastUpdated || "").trim()
  };
};

const getLibraryOccupancyPayload = () => ({
  ok: true,
  source: LIBRARY_DATA_SOURCE,
  prototype: true,
  generatedAt: new Date().toISOString(),
  libraries: mockLibraryOccupancy.map(normalizeLibraryOccupancy)
});

export function registerLibraryApiRoutes(app) {
  app.get("/api/libraries/health", (_request, response) => {
    response.json({
      ok: true,
      source: LIBRARY_DATA_SOURCE,
      prototype: true,
      libraries: mockLibraryOccupancy.length
    });
  });

  app.get("/api/libraries/occupancy", (_request, response) => {
    response.json(getLibraryOccupancyPayload());
  });
}
