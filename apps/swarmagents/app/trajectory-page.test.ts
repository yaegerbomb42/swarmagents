import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TrajectoryPage from "./runs/[id]/trajectory/page";

test("the replay page mounts the owner-checked trajectory viewer for its run id", async () => {
  const page = await TrajectoryPage({ params: Promise.resolve({ id: "run_replay" }) });
  const html = renderToStaticMarkup(React.createElement(() => page));
  assert.match(html, /run_replay/);
  assert.match(html, /Loading trajectory/);
});
