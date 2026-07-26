// Codec derivation from the init segment (`codecsFromInit`). The player builds its SourceBuffer with the
// codec parsed from the ACTUAL init `moov` (avcC / esds) rather than a hardcoded guess — a wrong `codecs=`
// (Main@L3 declared for 1080p High, or phantom audio on a video-only asset) makes the browser accept the
// append but silently fail to decode. These tests hand-build minimal fMP4 init segments and pin the parse.
// Pure/headless (no DOM/MSE). Run: `bun test` from repo root.

import { test, expect } from "bun:test";
import { codecsFromInit } from "../src/player.ts";

// ---- tiny ISO-BMFF builders -----------------------------------------------------------------------------
const bytes = (...xs: number[]): Uint8Array => new Uint8Array(xs);
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const size = 8 + body.length;
  const hdr = new Uint8Array(8);
  hdr[0] = (size >>> 24) & 0xff;
  hdr[1] = (size >>> 16) & 0xff;
  hdr[2] = (size >>> 8) & 0xff;
  hdr[3] = size & 0xff;
  for (let i = 0; i < 4; i++) hdr[4 + i] = type.charCodeAt(i);
  return concat([hdr, body]);
}
const zeros = (n: number): Uint8Array => new Uint8Array(n);
const descriptor = (tag: number, payload: Uint8Array): Uint8Array => concat([bytes(tag, payload.length), payload]);

// avc1 sample entry: 78-byte VisualSampleEntry header + avcC(config, profile, compat, level).
function avc1Entry(profile: number, compat: number, level: number): Uint8Array {
  const avcC = box("avcC", bytes(1, profile, compat, level, 0xff, 0xe1, 0x00, 0x00));
  return box("avc1", zeros(78), avcC);
}
// mp4a sample entry: 28-byte AudioSampleEntry header + esds(→ AAC-LC, AOT 2).
function mp4aEntry(): Uint8Array {
  const dsi = descriptor(0x05, bytes(0x12, 0x10)); // AudioSpecificConfig: first 5 bits = 2 (AAC-LC)
  const dcd = descriptor(0x04, concat([bytes(0x40, 0x15, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0), dsi]));
  const esd = descriptor(0x03, concat([bytes(0x00, 0x01, 0x00), dcd]));
  const esds = box("esds", concat([zeros(4), esd])); // FullBox version/flags then the ES_Descriptor
  return box("mp4a", zeros(28), esds);
}
const stsd = (entry: Uint8Array): Uint8Array => box("stsd", zeros(4), bytes(0, 0, 0, 1), entry);
const trak = (entry: Uint8Array): Uint8Array => box("trak", box("mdia", box("minf", box("stbl", stsd(entry)))));
const initOf = (...traks: Uint8Array[]): Uint8Array => concat([box("ftyp", bytes(0x69, 0x73, 0x6f, 0x36)), box("moov", ...traks)]);

// ---- tests --------------------------------------------------------------------------------------------
test("derives avc1 (High@L4.0) + mp4a from a muxed init", () => {
  const init = initOf(trak(avc1Entry(0x64, 0x00, 0x28)), trak(mp4aEntry()));
  expect(codecsFromInit(init)).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
});

test("reads the real profile/level (Main@L3.0 → avc1.4d401e)", () => {
  const init = initOf(trak(avc1Entry(0x4d, 0x40, 0x1e)));
  expect(codecsFromInit(init)).toBe('video/mp4; codecs="avc1.4d401e"');
});

test("omits audio for a video-only init (no phantom mp4a that would stall the SourceBuffer)", () => {
  const init = initOf(trak(avc1Entry(0x64, 0x00, 0x28)));
  expect(codecsFromInit(init)).toBe('video/mp4; codecs="avc1.640028"');
});

test("declines (null) when a video track is present but its codec can't be parsed", () => {
  const hvc1 = box("hvc1", zeros(78)); // recognized as video, but no hvcC parse → don't guess
  const init = initOf(trak(hvc1));
  expect(codecsFromInit(init)).toBeNull();
});

test("returns null on non-fMP4 / empty input", () => {
  expect(codecsFromInit(new Uint8Array(0))).toBeNull();
  expect(codecsFromInit(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))).toBeNull();
});
