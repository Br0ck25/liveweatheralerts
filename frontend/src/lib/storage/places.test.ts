import { describe, expect, it, beforeEach } from "vitest";
import { LOCATION_STORAGE_KEY } from "./location";
import {
  PLACES_STORAGE_KEY,
  createSavedPlaceFromResolvedLocation,
  readSavedPlaces,
  removeSavedPlaceById,
  setPrimarySavedPlace,
  upsertSavedPlace,
  writeSavedPlaces
} from "./places";

describe("places storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("migrates a legacy single saved location into SavedPlace[]", () => {
    window.localStorage.setItem(
      LOCATION_STORAGE_KEY,
      JSON.stringify({
        stateCode: "OH",
        rawInput: "Akron, OH",
        label: "Akron, OH",
        countyName: "Summit County",
        countyCode: "153",
        lat: 41.08,
        lon: -81.51,
        savedAt: "2026-03-26T00:00:00.000Z"
      })
    );

    const places = readSavedPlaces();

    expect(places).toHaveLength(1);
    expect(places[0]).toEqual(
      expect.objectContaining({
        stateCode: "OH",
        label: "Akron, OH",
        countyCode: "153",
        isPrimary: true
      })
    );

    const stored = JSON.parse(
      window.localStorage.getItem(PLACES_STORAGE_KEY) || "[]"
    ) as unknown[];
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
  });

  it("supports add, edit, remove, and set-primary behavior", () => {
    const home = createSavedPlaceFromResolvedLocation({
      id: "place-home",
      label: "Home",
      rawInput: "Louisville, KY",
      stateCode: "KY",
      countyName: "Jefferson County",
      countyCode: "111",
      lat: 38.25,
      lon: -85.76,
      isPrimary: true
    });
    const work = createSavedPlaceFromResolvedLocation({
      id: "place-work",
      label: "Work",
      rawInput: "Cincinnati, OH",
      stateCode: "OH",
      countyName: "Hamilton County",
      countyCode: "061",
      lat: 39.1,
      lon: -84.5
    });

    const withTwoPlaces = upsertSavedPlace([home], work);
    expect(withTwoPlaces).toHaveLength(2);
    expect(withTwoPlaces.find((place) => place.id === "place-home")?.isPrimary).toBe(true);

    const renamedWork = upsertSavedPlace(withTwoPlaces, {
      ...work,
      label: "Family"
    });
    expect(renamedWork.find((place) => place.id === "place-work")?.label).toBe("Family");

    const switchedPrimary = setPrimarySavedPlace(renamedWork, "place-work");
    expect(switchedPrimary.find((place) => place.id === "place-work")?.isPrimary).toBe(true);
    expect(switchedPrimary.find((place) => place.id === "place-home")?.isPrimary).toBe(false);

    const removedHome = removeSavedPlaceById(switchedPrimary, "place-home");
    expect(removedHome).toHaveLength(1);
    expect(removedHome[0].id).toBe("place-work");
    expect(removedHome[0].isPrimary).toBe(true);

    const persisted = writeSavedPlaces(removedHome);
    expect(persisted).toHaveLength(1);
    expect(
      JSON.parse(window.localStorage.getItem(LOCATION_STORAGE_KEY) || "{}")
    ).toEqual(
      expect.objectContaining({
        stateCode: "OH",
        label: "Family"
      })
    );
  });
});
