import { describe, expect, it } from "vitest";
import { endpointAfterRegionChange, PRESETS } from "./presets";

const preset = (id: string) => PRESETS.find((p) => p.id === id)!;

describe("endpointAfterRegionChange", () => {
  it("re-templates an endpoint that still matches the previous region", () => {
    expect(endpointAfterRegionChange(preset("aws"), "https://s3.us-east-1.amazonaws.com", "us-east-1", "eu-west-3")).toBe(
      "https://s3.eu-west-3.amazonaws.com",
    );
  });

  it("treats an empty previous region as the preset default", () => {
    expect(endpointAfterRegionChange(preset("wasabi"), "https://s3.us-east-1.wasabisys.com", "", "eu-central-1")).toBe(
      "https://s3.eu-central-1.wasabisys.com",
    );
  });

  it("keeps an endpoint the user edited", () => {
    expect(endpointAfterRegionChange(preset("aws"), "https://s3.custom.example.com", "us-east-1", "eu-west-3")).toBe(
      "https://s3.custom.example.com",
    );
  });

  it("keeps the endpoint for a preset without a region placeholder or no preset", () => {
    expect(endpointAfterRegionChange(preset("minio"), "http://localhost:9000", "us-east-1", "eu-west-1")).toBe("http://localhost:9000");
    expect(endpointAfterRegionChange(null, "https://s3.example.com", "a", "b")).toBe("https://s3.example.com");
  });
});
