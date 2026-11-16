/** Test probe: appends every `herdr:blocked` event to $HERDR_PROBE_FILE as a JSON line. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const file = process.env.HERDR_PROBE_FILE;
  if (!file) return;
  pi.events.on("herdr:blocked", (data: unknown) => appendFileSync(file, `${JSON.stringify(data)}\n`));
}
