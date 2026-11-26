import test from "node:test";
import assert from "node:assert/strict";
import { safeMediaPath, decodeMediaFile } from "./media.js";

test("accepts a safe music path and normalizes separators", () => {
  assert.equal(safeMediaPath("Music\Track 01.mp3"), "Music/Track 01.mp3");
  assert.equal(safeMediaPath("Новые треки/Песня (live).flac"), "Новые треки/Песня (live).flac");
});

test("rejects traversal, absolute paths and unsafe path segments", () => {
  for (const value of [
    "../shell.php.mp3",
    "Music/../../shell.mp3",
    "/etc/passwd.mp3",
    "C:\\Windows\\system.mp3",
    "Music//track.mp3",
    ".hidden/track.mp3",
    "Music/track.exe",
    "Music/track.mp3?x=1"
  ]) {
    assert.equal(safeMediaPath(value), null, value);
  }
  assert.equal(safeMediaPath(null), null);
});

test("decodes a valid base64 media file within size limit", () => {
  const data = Buffer.from("audio bytes");
  assert.deepEqual(decodeMediaFile(data.toString("base64"), 100), data);
});

test("rejects malformed or oversized base64 media", () => {
  assert.equal(decodeMediaFile("not base64", 100), null);
  assert.equal(decodeMediaFile(Buffer.from("too long").toString("base64"), 2), null);
  assert.equal(decodeMediaFile("", 100), null);
  assert.equal(decodeMediaFile("YQ==", 0), null);
});
