import test from "node:test";
import assert from "node:assert/strict";
import { toAzuraStationPath } from "./azura-path.js";

const prefix = "/api/admin/azuracast/station/42/";

test("maps collection and item routes to AzuraCast's documented resource paths", () => {
  assert.equal(toAzuraStationPath(prefix + "files", "42"), "station/42/files");
  assert.equal(toAzuraStationPath(prefix + "files/123", "42"), "station/42/file/123");
  assert.equal(toAzuraStationPath(prefix + "files/123/play", "42"), "station/42/file/123/play");
  assert.equal(toAzuraStationPath(prefix + "playlists", "42"), "station/42/playlists");
  assert.equal(toAzuraStationPath(prefix + "playlists/456", "42"), "station/42/playlist/456");
});

test("rejects other stations, upload paths and arbitrary AzuraCast endpoints", () => {
  for (const path of [
    "/api/admin/azuracast/station/99/files",
    prefix + "files/upload",
    prefix + "files/1/rename",
    prefix + "playlists/5/play",
    prefix + "station",
  ]) {
    assert.equal(toAzuraStationPath(path, "42"), null, path);
  }
  assert.equal(toAzuraStationPath(prefix + "files", ""), null);
});
