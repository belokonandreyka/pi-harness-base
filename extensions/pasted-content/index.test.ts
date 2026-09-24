import { describe, expect, test } from "bun:test";
import pastedContentExtension, { DEFAULTS, splitPaste, wrap } from "./index.ts";

const cfg = { enabled: true, ...DEFAULTS };
const mail = Array.from({ length: 14 }, (_, i) => `line ${i + 1} of the forwarded thread, nothing to see here`).join("\n");

describe("pasted-content", () => {
  test("wraps the bulk and keeps the user's own words outside", () => {
    const text = `Summarize the complaints in this thread.\n\n${mail}\n\nfocus on the refunds`;
    const out = wrap(text, cfg, "ab12")!;
    expect(out.startsWith("Summarize the complaints in this thread.\n\n<pasted_content id=\"ab12\">\nline 1")).toBe(true);
    expect(out.endsWith("\n</pasted_content id=\"ab12\">\n\nfocus on the refunds")).toBe(true);
    expect(out).toContain(mail);
  });

  test("leaves short messages, tagged messages and slash commands alone", () => {
    expect(wrap("fix the typo in README", cfg)).toBeNull();
    expect(wrap(`ask\n<pasted_content id="x1">\n${mail}\n</pasted_content id="x1">`, cfg)).toBeNull();
    const handlers = new Map<string, any>();
    pastedContentExtension({ on: (e: string, h: any) => handlers.set(e, h) } as any);
    expect(handlers.get("input")({ source: "interactive", text: `/model\n${mail}` })).toEqual({ action: "continue" });
    expect(handlers.get("input")({ source: "rpc", text: `task\n\n${mail}` })).toEqual({ action: "continue" });
  });

  test("a paste with no words of the user's own is wrapped whole", () => {
    const parts = splitPaste(mail, cfg)!;
    expect(parts.head).toEqual([]);
    expect(parts.tail).toEqual([]);
    expect(parts.body.length).toBe(14);
  });

  test("a long single-line paste counts by characters", () => {
    const long = "x".repeat(1200);
    const out = wrap(`what is this?\n\n${long}`, cfg, "cd34")!;
    expect(out).toBe(`what is this?\n\n<pasted_content id="cd34">\n${long}\n</pasted_content id="cd34">`);
  });

  test("interactive input is transformed with images carried over", () => {
    const handlers = new Map<string, any>();
    pastedContentExtension({ on: (e: string, h: any) => handlers.set(e, h) } as any);
    const r = handlers.get("input")({ source: "interactive", text: `look\n\n${mail}`, images: [{ type: "image", data: "d" }] });
    expect(r.action).toBe("transform");
    expect(r.text).toMatch(/<pasted_content id="[0-9a-f]{4}">/);
    expect(r.images.length).toBe(1);
  });
});
