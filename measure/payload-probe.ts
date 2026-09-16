import { writeFileSync } from "node:fs";

/** Dumps a size breakdown of the request pi hands to the provider. */
export default function probe(pi: any) {
  let written = false;
  writeFileSync("/tmp/pi-probe-loaded.txt", new Date().toISOString(), "utf-8");

  pi.on("before_provider_request", (event: any) => {
    if (written) return;
    written = true;

    const payload = event?.payload ?? {};
    const chars = (v: unknown) => (v === undefined ? 0 : JSON.stringify(v).length);

    // The system field is a string on some providers and a block array on others.
    const system = payload.system ?? payload.instructions;
    let systemText = "";
    if (typeof system === "string") systemText = system;
    else if (Array.isArray(system)) {
      systemText = system
        .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
        .join("\n");
    }

    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const toolSizes = tools
      .map((t: any) => ({ name: t?.name ?? t?.function?.name ?? "?", chars: chars(t) }))
      .sort((a: any, b: any) => b.chars - a.chars);

    // Skills are advertised as a block inside the system prompt; find whatever
    // wrapper this pi version uses rather than guessing one.
    const skillMatch =
      systemText.match(/<available_skills>[\s\S]*?<\/available_skills>/) ??
      systemText.match(/<skills>[\s\S]*?<\/skills>/) ??
      systemText.match(/<skill[\s\S]*?<\/skill[a-z_]*>/);

    const report = {
      payloadKeys: Object.keys(payload),
      totalChars: chars(payload),
      system: {
        chars: systemText.length,
        skillsBlockChars: skillMatch ? skillMatch[0].length : null,
        head: systemText.slice(0, 160),
        skillMentions: (systemText.match(/skill/gi) || []).length,
        aroundSkill: (() => { const i = systemText.search(/skill/i); return i < 0 ? "" : systemText.slice(Math.max(0, i - 120), i + 400); })(),
      },
      tools: {
        count: tools.length,
        chars: chars(payload.tools),
        largest: toolSizes.slice(0, 6),
      },
      messages: {
        count: Array.isArray(payload.messages ?? payload.input) ? (payload.messages ?? payload.input).length : 0,
        chars: chars(payload.messages ?? payload.input),
      },
    };

    writeFileSync("/tmp/pi-payload-report.json", JSON.stringify(report, null, 2), "utf-8");
  });
}
