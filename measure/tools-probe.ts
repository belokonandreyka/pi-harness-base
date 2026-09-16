import { writeFileSync } from "node:fs";

/**
 * Dumps every configured tool with its source and the size it contributes to
 * each request. Runs off `session_start`, so it needs no model call.
 */
export default function probe(pi: any) {
  pi.on("session_start", (_event: unknown, ctx: any) => {
    try {
      const tools = pi.getAllTools?.() ?? [];
      const active = new Set(pi.getActiveTools?.() ?? []);

      const rows = tools.map((t: any) => {
        // What a provider actually serialises for the tool: name, description
        // and the parameter schema.
        const wire = {
          name: t?.name,
          description: t?.description,
          parameters: t?.parameters,
        };
        return {
          name: t?.name ?? "?",
          source: t?.sourceInfo?.source ?? t?.sourceInfo?.name ?? "?",
          scope: t?.sourceInfo?.scope ?? "?",
          path: t?.sourceInfo?.path ?? null,
          chars: JSON.stringify(wire).length,
          active: active.has(t?.name),
        };
      });

      writeFileSync(
        "/tmp/pi-tools-report.json",
        JSON.stringify({ cwd: ctx?.cwd, count: rows.length, tools: rows }, null, 2),
        "utf-8",
      );
    } catch (err) {
      writeFileSync("/tmp/pi-tools-report.json", JSON.stringify({ error: String(err) }), "utf-8");
    }
  });
}
