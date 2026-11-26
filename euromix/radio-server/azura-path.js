/**
 * Maps the small Euromix admin route surface to AzuraCast's station API.
 * Collection routes remain plural; individual file and playlist endpoints
 * use AzuraCast's singular resource path. The Flow.js upload route is never
 * part of this allowlist.
 */
export function toAzuraStationPath(pathname, stationId) {
  if (!/^\d+$/.test(String(stationId || ""))) return null;
  const prefix = "/api/admin/azuracast/station/";
  if (typeof pathname !== "string" || !pathname.startsWith(prefix)) return null;

  const tail = pathname.slice(prefix.length);
  const match = /^(\d+)\/(files|playlists)(?:\/(\d+)(?:\/(play))?)?$/.exec(tail);
  if (!match || match[1] !== String(stationId)) return null;

  const [, , resource, id, action] = match;
  const station = "station/" + stationId + "/";
  if (!id) return station + resource;
  if (resource === "files") {
    return station + "file/" + id + (action ? "/play" : "");
  }
  if (action) return null;
  return station + "playlist/" + id;
}
