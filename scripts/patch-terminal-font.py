#!/usr/bin/env python3
"""Build a JetBrains Mono that carries the Herdr agent-icon glyphs.

Terminal.app has one font per profile and no fallback setting, so the
qintmb.herdr-icon-agent-ui plugin's private-use glyphs (U+E1A0-U+E1B0) render
as boxes there. This script copies them into a JetBrains Mono Regular, maps U+2B24
(the plugin's LED glyph, which JetBrains Mono lacks and macOS otherwise draws
too wide, swallowing the space after it) to the cell-sized ● outline, adds the
half circles ◐ ◑ (U+25D0/25D1, which JetBrains Mono lacks: the pi footer's
context bar uses them, and a fallback font draws them larger than ○ ●), and
installs the result as one family you pick in Terminal > Settings > Profiles >
Text. Ghostty can use the same font. Running it on an already patched font
(`--jbm ~/Library/Fonts/JetBrainsMonoHerdr-Regular.ttf`) only adds what is
missing.

  scripts/patch-terminal-font.py                # download JetBrains Mono, write ~/Library/Fonts
  scripts/patch-terminal-font.py --jbm path/to/JetBrainsMono-Regular.ttf --out ./x.ttf

fontTools is fetched into a temporary directory when it is not importable.
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HOME = os.path.expanduser("~")
ICON_GLOB = os.path.join(HOME, ".config/herdr/plugins/*/qintmb.herdr-icon-agent-ui*/dist/HerdrAgentIconsMax-Regular.ttf")
JBM_RELEASES = "https://api.github.com/repos/JetBrains/JetBrainsMono/releases/latest"
LED, LED_SOURCE = 0x2B24, 0x25CF   # ⬤ is drawn with the cell-sized ● outline
RING = 0x25CB                      # ○: outer contour, then the hole
HALF_LEFT, HALF_RIGHT = 0x25D0, 0x25D1   # ◐ left half black, ◑ right half black


def half_circle(base, filled_left: bool):
    """◐ / ◑ in JetBrains Mono's own construction: the outer contour of ○ plus
    a hole that is the other half of the inner disk (◔ is built the same way,
    with a three-quarter hole), so size and stroke match ○ ● ◔ ◕ exactly."""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.recordingPen import RecordingPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    glyf, cmap = base["glyf"], base.getBestCmap()
    ring = glyf[cmap[RING]]
    rec = RecordingPen()
    ring.draw(rec, glyf)
    first_close = next(i for i, (op, _) in enumerate(rec.value) if op in ("closePath", "endPath"))
    outer = rec.value[: first_close + 1]
    coords, ends, _ = ring.getCoordinates(glyf)
    inner = coords[ends[0] + 1 : ends[1] + 1]
    xs, ys = [p[0] for p in inner], [p[1] for p in inner]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    r = (max(xs) - min(xs)) / 2
    k = 0.5523 * r  # cubic quarter-circle handle

    pen = TTGlyphPen(None)
    for op, args in outer:
        getattr(pen, op)(*args)
    q = Cu2QuPen(pen, max_err=0.5)
    # The hole runs counter-clockwise like ○'s; the half it covers stays white.
    if filled_left:  # hole = right half: bottom → right → top, then straight down
        q.moveTo((cx, cy - r))
        q.curveTo((cx + k, cy - r), (cx + r, cy - k), (cx + r, cy))
        q.curveTo((cx + r, cy + k), (cx + k, cy + r), (cx, cy + r))
    else:  # hole = left half: top → left → bottom, then straight up
        q.moveTo((cx, cy + r))
        q.curveTo((cx - k, cy + r), (cx - r, cy + k), (cx - r, cy))
        q.curveTo((cx - r, cy - k), (cx - k, cy - r), (cx, cy - r))
    q.closePath()
    return pen.glyph(), base["hmtx"][cmap[RING]]


def ensure_fonttools(tmp: str):
    try:
        import fontTools  # noqa: F401
        return
    except ImportError:
        pass
    print("fetching fontTools into a temporary directory")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--target", tmp, "fonttools"], check=True)
    sys.path.insert(0, tmp)


def download_jbm(tmp: str) -> str:
    with urllib.request.urlopen(JBM_RELEASES, timeout=30) as r:
        release = json.load(r)
    url = next(a["browser_download_url"] for a in release["assets"] if a["name"].endswith(".zip"))
    print("downloading", url)
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(n for n in z.namelist() if n.endswith("ttf/JetBrainsMono-Regular.ttf"))
        z.extract(member, tmp)
    return os.path.join(tmp, member), release["tag_name"]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--icon-font", help=f"plugin TTF (default: first match of {ICON_GLOB})")
    p.add_argument("--jbm", help="JetBrainsMono-Regular.ttf (default: latest GitHub release)")
    p.add_argument("--out", default=os.path.join(HOME, "Library/Fonts/JetBrainsMonoHerdr-Regular.ttf"))
    p.add_argument("--family", default="JetBrains Mono Herdr")
    a = p.parse_args()

    icon = a.icon_font or next(iter(sorted(glob.glob(ICON_GLOB))), None)
    if not icon or not os.path.exists(icon):
        print("icon font not found; install the plugin first or pass --icon-font", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        ensure_fonttools(tmp)
        from fontTools.ttLib import TTFont
        jbm, version = (a.jbm, "local") if a.jbm else download_jbm(tmp)
        base, icons = TTFont(jbm), TTFont(icon)
        if base["head"].unitsPerEm != icons["head"].unitsPerEm:
            print("units-per-em differ; the plugin font is built for JetBrains Mono metrics", file=sys.stderr)
            return 1
        glyf, hmtx, order = base["glyf"], base["hmtx"], base.getGlyphOrder()
        unicode_tables = [t for t in base["cmap"].tables if t.isUnicode()]
        base_cmap = base.getBestCmap()
        added = []

        def add(name: str, cp: int, glyph, metrics):
            glyf.glyphs[name] = glyph
            hmtx.metrics[name] = metrics
            order.append(name)
            for t in unicode_tables:
                t.cmap[cp] = name
            added.append(cp)

        for cp, gname in sorted(icons.getBestCmap().items()):
            if f"herdr.{cp:04X}" in glyf.glyphs:
                continue  # an already patched font: only add what is missing
            if icons["glyf"][gname].isComposite():
                print(f"skipping composite glyph {gname}", file=sys.stderr)
                continue
            add(f"herdr.{cp:04X}", cp, icons["glyf"][gname], icons["hmtx"][gname])
        if RING in base_cmap:
            for cp, left in ((HALF_LEFT, True), (HALF_RIGHT, False)):
                if cp not in base_cmap:
                    glyph, metrics = half_circle(base, left)
                    add(f"uni{cp:04X}", cp, glyph, metrics)
        if LED not in base_cmap and LED_SOURCE in base_cmap:
            for t in unicode_tables:
                t.cmap[LED] = base_cmap[LED_SOURCE]
            added.append(LED)

        base.setGlyphOrder(order)
        base["maxp"].numGlyphs = len(order)
        if base["post"].formatType == 2.0:
            base["post"].extraNames, base["post"].mapping = [], {}
        ps = a.family.replace(" ", "") + "-Regular"
        for r in base["name"].names:
            if r.nameID in (1, 16):
                r.string = a.family
            elif r.nameID == 4:
                r.string = a.family + " Regular"
            elif r.nameID == 6:
                r.string = ps
            elif r.nameID == 3:
                r.string = f"{version};{ps}"
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        base.save(a.out)
    print(f"wrote {a.out}: {len(added)} glyphs added ({', '.join(f'U+{c:04X}' for c in added)})")
    print(f"family '{a.family}', PostScript '{ps}'. If it is not offered yet, open it once in Font Book:")
    print(f"  open '{a.out}'")
    print("Terminal.app: Settings > Profiles > Text > Font, or")
    print(f"  osascript -e 'tell application \"Terminal\" to set font name of settings set \"<profile>\" to \"{ps}\"'")
    print(f"Ghostty: font-family = \"{a.family}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
