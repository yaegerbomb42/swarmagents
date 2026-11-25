/**
 * Component tests for the desktop viewport polish (v2-ui viewport): the
 * booting overlay names the VM's actual state instead of "Starting VM…" for
 * everything, the overlays are glass cards over the stage, and the noVNC
 * surface is GPU-layered so overlay repaints never force a canvas repaint.
 * Static renders (see testing/harness.ts): effects never run, so the
 * connection machine sits at its initial "starting" phase.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs, tagOf } from "../testing/harness";

const h = React.createElement;

/** Components are imported after the browser stubs are in place (noVNC). */
async function load() {
  installBrowserStubs();
  return import("./DesktopView");
}

test("the booting overlay names the VM's actual state", async () => {
  const { bootingOverlayCopy } = await load();

  assert.deepEqual(bootingOverlayCopy("starting", "starting"), {
    title: "Waking up your computer.",
    detail: "Starting VM…",
  });
  assert.deepEqual(bootingOverlayCopy("hibernated", "starting"), {
    title: "Waking your computer",
    detail: "Hibernated after being idle — starting it back up…",
  });
  assert.deepEqual(bootingOverlayCopy("error", "starting", "VNC refused the connection"), {
    title: "Computer error",
    detail: "VNC refused the connection",
  });
  assert.deepEqual(bootingOverlayCopy("error", "starting"), {
    title: "Computer error",
    detail: "Something went wrong — try resetting the computer.",
  });
  // The dial phase outranks the VM state: a ready VM still has to connect.
  assert.deepEqual(bootingOverlayCopy("ready", "connecting"), {
    title: "Connecting to desktop",
    detail: "Dialing your computer's screen…",
  });
  assert.deepEqual(bootingOverlayCopy("hibernated", "connecting"), {
    title: "Connecting to desktop",
    detail: "Dialing your computer's screen…",
  });
});

test("the embedded booting overlay is a glass card with a desktop skeleton", async () => {
  const { DesktopView } = await load();
  const markup = renderToStaticMarkup(
    h(DesktopView, { vmState: "starting", embedded: true }),
  );
  assert.equal(countOf(markup, 'data-testid="desktop-overlay"'), 1, "one booting overlay");
  assert.equal(countOf(markup, 'data-testid="desktop-boot-skeleton"'), 1, "a skeleton of the desktop that is coming");
  assert.match(markup, /Waking up your computer\./);
  assert.match(markup, /Starting VM…/);
  assert.match(markup, /glass-soft/, "the card uses the shared glass material");
  assert.match(markup, /backdrop-blur/, "the overlay dims and blurs the stage behind it");
  assert.match(markup, /transform-gpu/, "the noVNC surface is GPU-layered");
});

test("a hibernated VM wakes up instead of 'starting', and an error names itself", async () => {
  const { DesktopView } = await load();
  const waking = renderToStaticMarkup(h(DesktopView, { vmState: "hibernated", embedded: true }));
  assert.match(waking, /Waking your computer/);
  assert.match(waking, /Hibernated after being idle/);
  assert.doesNotMatch(waking, /Starting VM…/, "a wake-up does not read as a first boot");

  const failed = renderToStaticMarkup(
    h(DesktopView, { vmState: "error", embedded: true, vmErrorMessage: "VNC refused the connection" }),
  );
  assert.match(failed, /Computer error/);
  assert.match(failed, /VNC refused the connection/);
});

test("the standalone view shares the same booting overlay", async () => {
  const { DesktopView } = await load();
  const markup = renderToStaticMarkup(h(DesktopView, { vmState: "starting" }));
  assert.equal(countOf(markup, 'data-testid="desktop-overlay"'), 1, "one booting overlay");
  assert.equal(countOf(markup, 'data-testid="desktop-boot-skeleton"'), 1);
  assert.match(markup, /Waking up your computer\./);
  assert.match(markup, /glass-soft/);
  assert.match(markup, /transform-gpu/);
  // The standalone path still renders its own controls row under the stage.
  assert.equal(countOf(markup, 'data-testid="desktop-fullscreen-button"'), 1);
});
