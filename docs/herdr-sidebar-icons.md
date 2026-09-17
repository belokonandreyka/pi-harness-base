# Herdr sidebar: agent logos and state glyphs

Optional. The Herdr sidebar lists panes by name only; the plugin
[qintmb/herdr-icon-agent-ui](https://github.com/qintmb/herdr-icon-agent-ui)
turns it into a workspace → tab → agent tree with a logo per agent, a braille
spinner while a subagent works, a held green `✓` when it finishes and an LED
for idle or blocked. With subagents in their own panes this is the quickest
way to see what is running. Follow the plugin's README for the plugin itself;
this page covers what the README leaves to you on macOS.

## 1. Plugin and layout

```bash
herdr plugin install qintmb/herdr-icon-agent-ui
cp ~/.config/herdr/config.toml ~/.config/herdr/config.toml.bak
```

Merge the plugin's `sidebar-layout.toml` into `~/.config/herdr/config.toml`
and set `agent_panel_sort = "spaces"`. The plugin ships a helper that does the
merge and keeps everything else in the file intact:

```bash
cd "$(dirname "$(herdr plugin list --json | python3 -c 'import json,sys; print(next(p["plugin_root"] for p in json.load(sys.stdin)["result"]["plugins"] if p["plugin_id"]=="qintmb.herdr-icon-agent-ui"))')" 2>/dev/null || cd ~/.config/herdr/plugins/github/qintmb.herdr-icon-agent-ui-*/
python3 -c '
from pathlib import Path
from configuration import merge_layout
c = Path.home()/".config/herdr/config.toml"
c.write_text(merge_layout(c.read_text(), Path("sidebar-layout.toml").read_text()))'
herdr config check && herdr server reload-config
```

Do not run the plugin's `setup_sidebar.py`: as of v2.0.0 it still refers to
the previous font and plugin id.

The layout colours only `claude` and `codex`; pi falls back to grey. Add the
`pi = [...]` array from [`herdr/sidebar-pi.toml`](../herdr/sidebar-pi.toml)
under `[ui.sidebar.agents.rows_by_agent]` in the same file, then:

```bash
herdr config check && herdr server reload-config
herdr plugin action invoke refresh --plugin qintmb.herdr-icon-agent-ui
```

`herdr pane get <pane-id>` shows the tokens the plugin wrote (`hs_logo`,
`hs_idle`, `hs_working`, ...).

## 2. The font

Logos are private-use codepoints (U+E1A0–U+E1B0) in the plugin's own font
`Herdr Agent Icons Max`. macOS registers nothing for that range by itself:
a CoreText probe from a plain SF Mono or Menlo falls through to LastResort,
so the terminal has to be told. Two routes:

**Ghostty.** Ghostty maps codepoints to a font explicitly. Install the font,
then in `~/Library/Application Support/com.mitchellh.ghostty/config`:

```ini
font-family = "JetBrains Mono"
font-family = "Herdr Agent Icons Max"
font-codepoint-map = U+E1A0-U+E1B0="Herdr Agent Icons Max"
```

**Terminal.app** has one font per profile and no fallback setting, so the
route is a patched font, the way Nerd Fonts do it:

```bash
scripts/patch-terminal-font.py
```

It downloads JetBrains Mono (OFL; its metrics are what the icon font was
built for), copies the 17 glyphs in, maps `⬤` (U+2B24, the plugin's LED, which
JetBrains Mono lacks and macOS otherwise draws too wide, swallowing the space
before the label) to the cell-sized `●` outline, and writes
`~/Library/Fonts/JetBrainsMonoHerdr-Regular.ttf`. Pick **JetBrains Mono
Herdr** in Terminal → Settings → Profiles → Text, or:

```bash
osascript -e 'tell application "Terminal" to set font name of settings set "Basic" to "JetBrainsMonoHerdr-Regular"'
```

Regular only; Terminal.app synthesises bold. The same single family works in
Ghostty (`font-family = "JetBrains Mono Herdr"`, no codepoint map needed).
If a freshly created `~/Library/Fonts` is not picked up at once, open the file
in Font Book.

Then switch the plugin to font glyphs:

```bash
printf 'icons = "font"\n' > "$(herdr plugin config-dir qintmb.herdr-icon-agent-ui)/config.toml"
herdr plugin action invoke refresh --plugin qintmb.herdr-icon-agent-ui
```

`icons = "text"` is the fallback (`π` for pi) if a terminal cannot be taught
the font.

## 3. Python

The plugin needs Python 3.11+ (`tomllib`). Herdr runs hooks with a short
PATH; the plugin's `run.sh` adds `/usr/local/bin` and Homebrew, so a
python.org or Homebrew Python is enough even though `/usr/bin/python3` is 3.9.
`herdr plugin log list --plugin qintmb.herdr-icon-agent-ui` shows each hook's
status and stderr.
