import test from "node:test";
import assert from "node:assert/strict";
import { defaultDriverName } from "./driver-default";

test("production defaults to a real Docker VM unless fake is explicitly selected", () => {
  assert.equal(defaultDriverName({}), "fake");
  assert.equal(defaultDriverName({ NODE_ENV: "development" }), "fake");
  assert.equal(defaultDriverName({ NODE_ENV: "test" }), "fake");
  assert.equal(defaultDriverName({ NODE_ENV: "production" }), "docker");
});
