// MSE attachment hardening. The player attaches its MediaSource to the <video> preferring the modern
// MediaSourceHandle + `srcObject` — the path that survives Chrome's removal of `URL.createObjectURL(
// MediaSource)` and is required for iOS ManagedMediaSource — falling back to the object URL only where a
// handle isn't available. These tests pin that branching (no real DOM/MSE) with fake video + MediaSource
// objects and a stubbed `URL.createObjectURL`. Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { attachMediaSource, createMediaSource } from "../src/player.ts";

// A minimal fake <video>: `srcObject` present only when the browser supports it (feature-detect target).
function fakeVideo(withSrcObject: boolean): any {
  const v: any = { src: "" };
  if (withSrcObject) {
    v.srcObject = null;
    v.disableRemotePlayback = false;
  }
  return v;
}

test("prefers the MediaSourceHandle + srcObject when a handle is available", () => {
  const handle = { __handle: true };
  const ms: any = { handle };
  const video = fakeVideo(true);
  const method = attachMediaSource(video, ms);
  expect(method).toBe("srcObject");
  expect(video.srcObject).toBe(handle); // attached via the modern, non-deprecated path
  expect(video.disableRemotePlayback).toBe(true); // required for ManagedMediaSource
  expect(video.src).toBe(""); // did NOT touch the deprecated object URL
});

test("falls back to createObjectURL when the MediaSource exposes no handle", () => {
  const orig = URL.createObjectURL;
  let passed: unknown = null;
  (URL as any).createObjectURL = (x: unknown) => {
    passed = x;
    return "blob:stub-a";
  };
  try {
    const ms: any = {}; // no .handle (older browser / no handle support)
    const video = fakeVideo(true);
    const method = attachMediaSource(video, ms);
    expect(method).toBe("objectURL");
    expect(video.src).toBe("blob:stub-a");
    expect(passed).toBe(ms);
    expect(video.srcObject).toBe(null); // untouched
  } finally {
    (URL as any).createObjectURL = orig;
  }
});

test("falls back to createObjectURL when the element has no srcObject", () => {
  const orig = URL.createObjectURL;
  (URL as any).createObjectURL = () => "blob:stub-b";
  try {
    const ms: any = { handle: { __handle: true } };
    const video = fakeVideo(false); // no srcObject support
    const method = attachMediaSource(video, ms);
    expect(method).toBe("objectURL");
    expect(video.src).toBe("blob:stub-b");
  } finally {
    (URL as any).createObjectURL = orig;
  }
});

test("createMediaSource prefers ManagedMediaSource, else MediaSource", () => {
  const g: any = globalThis;
  const origMMS = g.ManagedMediaSource;
  const origMS = g.MediaSource;
  class FakeMMS {}
  class FakeMS {}
  try {
    g.ManagedMediaSource = FakeMMS;
    g.MediaSource = FakeMS;
    expect(createMediaSource()).toBeInstanceOf(FakeMMS); // iOS Safari path

    g.ManagedMediaSource = undefined;
    expect(createMediaSource()).toBeInstanceOf(FakeMS); // standard path
  } finally {
    g.ManagedMediaSource = origMMS;
    g.MediaSource = origMS;
  }
});
