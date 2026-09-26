---
name: video-digest
description: Answer "what happens in this screen recording" without sending video to a model. Samples a local .mov/.mp4/.webm/.mkv/.gif, keeps only the frames where the screen actually changed (toast, error, modal, navigation, checkbox), caps them so the token cost stays flat regardless of length, and hands them to an image-capable subagent that writes a timestamped text timeline. Supports a time window and a coarse-then-dense two-pass for long recordings. Use when the user points at a video file and asks what is on it, when an error appears, what was clicked before a crash, or asks to "find X in the video" (in any language). For videos attached to a ticket, the project overlay's fetch skill downloads first and then calls this one.
---

# Video digest (screen recording → keyframes → text timeline)

Read fully before the first tool call. The recording never goes to a model;
only a bounded set of PNG keyframes does, and the coordinator only ever sees
the resulting **text**.

## When to use

- A local video file and a question about it: "what does QA do here",
  "when does the toast appear", "which button was pressed before the crash",
  "does the checkbox state change".
- As the second half of a ticket-video skill that already downloaded the file.

Do NOT use for:
- Static screenshots — `read` the PNG directly.
- Loom / Drive / YouTube links — downloading needs `yt-dlp` and a session;
  tell the user and stop.

## Prerequisites

- `ffmpeg` / `ffprobe` on PATH (`brew install ffmpeg`; 9.x uses `-fps_mode`,
  the old `-vsync` is gone).
- `uv` — the script is a PEP 723 single file, deps land in a cached env on
  first run.

Script: `$PI_CODING_AGENT_DIR/skills/video-digest/scripts/video_digest.py`
(default profile: `~/.pi/agent/skills/video-digest/scripts/video_digest.py`).
Below `VD` stands for `uv run --quiet --script <that path>`.

## Why the cost does not grow with the length

`--max` (default 24) caps the keyframes. First and last always stay; the rest
are ranked by how much the picture changed and only the top ones survive.
A 30-minute recording therefore costs the same ~25–30k tokens as a 90-second
one — it is just covered more coarsely, and small events (a toast, a checkbox)
can be pushed out by big ones (page navigations). The answer to a long video
is a **narrower window**, not a bigger cap.

## Flow

### 0. Decide the window first

```bash
VD probe <video>        # duration, size, audio — 1 line of JSON
```

| Situation | Do |
| --- | --- |
| ≤ 3 min | one pass on the whole file, step 1 |
| longer, user knows roughly where (e.g. "around minute 12") | one dense pass on that window: `--start 11:00 --end 13:30` |
| longer, nobody knows where | two passes: coarse on the whole file, then dense on the window you pick (step 1b) |

### 1. Extract

```bash
VD frames <video> --sheet                              # whole file
VD frames <video> --start 11:00 --end 13:30 --sheet    # window
```

Timestamps accept `95`, `1:35`, `01m35s`, `0:01:35` and are always reported
relative to the **original** video, also inside a window, so the timeline the
subagent writes matches what the user sees in their player.

Output next to the video in `<stem>/` (or `<stem>/w-<from>-<to>/` for a
window, so passes never clobber each other):
- `frames/NN-MMmSSs.png` — keyframes, 1280 px wide, time order
- `frames.json` — timestamps, change scores, `has_audio`, `capped`
- `frames.md` — **the block to paste into the subagent prompt**
- `contact-sheet.png` — 4-column overview with `#N mm:ss` labels (`--sheet`)

#### 1b. Two-pass for a long recording

```bash
VD frames <video> --fps 0.5 --change 0.01 --sheet      # coarse: 1 sample / 2 s, big changes only
```

`read` the contact sheet (one ~2k-token image) — it shows *where* the
navigation / dialog / error moments sit on the clock. Pick the stretch that
contains the question, then:

```bash
VD frames <video> --start <from> --end <to> --sheet     # dense, default thresholds
```

Two or three windows are fine; each is its own folder and its own subagent
call. Do not raise `--fps` above 2 — it does not find more UI states, it just
burns disk.

### 2. Sanity-check (coordinator, 30 seconds)

Read `frames.md`; glance at `contact-sheet.png` with `read`.

| Symptom | Action |
| --- | --- |
| 3–24 frames, each visibly a different UI state | proceed |
| `capped: true` / "hit the cap" note | narrow the window; only if the window is already short, `--max 40` |
| 1–2 frames but the user clearly clicks around | `--change 0.001 --hash-bits 4` (changes are small: a checkbox, a field value) |
| many frames `(unsettled, mid-animation)` | scrolling or a spinner; `--force 8`, or pass the contact sheet only |
| `has_audio: true` | `--transcribe` (needs `uv tool install mlx-whisper`; first run pulls `whisper-large-v3-turbo`, ~1.6 GB); narration usually names the expected behaviour and is the fastest way to learn what QA thinks is wrong. Check the level first: `ffmpeg -i <video> -af volumedetect -vn -f null -` — mean above about −45 dB is speech |

How selection works, so the knobs make sense: samples at `--fps` (2), a frame
is a *change* when > `--change` (0.3 %) of pixels moved vs the last kept frame
or dhash distance > `--hash-bits` (8/256), and it is kept only once the next
sample is stable (< `--stable`, 0.1 %) — i.e. after the animation finished.
Cursor movement alone (~0.02 %) never triggers; a hover highlight on a
full-width row does, which is fine.

### 3. Spawn the vision subagent

`subagent` tool, type **`sonnet-5`** (image-capable, read-only prompt).
Fallback: `gemini-flash`. Do NOT use `haiku-recon` — it misreads small UI
text. Do NOT pass frames to a scout or a worker; they get the text digest.

Prompt — copy verbatim, substitute `<CONTEXT>` (what the recording is and what
the user is trying to learn), `<QUESTION>` (the concrete question, or "describe
what happens"), `<FRAMES_MD>` (full contents of `frames.md`):

```
You are a READ-ONLY vision subagent. You describe what a screen recording
shows; you do not investigate code and you do not modify anything.

Hard rules:
- Only `read` the PNG files listed below (and the contact sheet if listed).
  No other files, no code, no bash except `ls` on the frames folder.
- Do not guess what the app "should" do from general knowledge. Report only
  what is visible, and quote on-screen text exactly (labels, button captions,
  error / toast copy, field values, URLs, breadcrumbs, table headers).
- If a frame is unreadable or ambiguous, say so instead of interpolating.

Context: <CONTEXT>
Question to answer: <QUESTION>

Frames (time order; each is the screen state AFTER a change settled;
timestamps are positions in the original video):
<FRAMES_MD>

Procedure:
1. `read` the frames strictly in order. For each, note what changed versus the
   previous frame (new element, text change, navigation, dialog, colour /
   validation state) — one or two lines per frame.
2. Then write the report.

Output (Markdown, exactly these sections):

## Timeline
- mm:ss — what the user did (if inferable from the change) → what the UI
  showed. Quote visible text in "quotes".

## Answer
2–4 sentences answering the question, naming the frame(s) and timestamps
that show it. If the frames do not show it, say "not visible in the
keyframes" and name the stretch of the video where it would have to be —
do not invent it.

## UI locators
Exact strings a developer can grep for: route hints from URLs or breadcrumbs,
button captions, field labels, error/toast copy, table columns, dialog
titles. One per line.

## Uncertain
Anything you could not read or where the frames skip a step.
```

### 4. Use the result

- Answer the user from the subagent's report; include the frames folder path
  so they can open the exact PNG, and the timestamps so they can scrub to it.
- "Not visible in the keyframes" + a named stretch → run a dense pass on that
  stretch (step 1b) before concluding anything.
- Feeding a scout: paste the report as a text block; **UI locators** is the
  part `rg` can use.

## Sharing a window

```bash
VD clip <video> --start 11:00 --end 13:30     # <video>-11m00s-13m30s.mp4, re-encoded, small
```

For when the user wants to attach just the relevant minute somewhere.

## Budget

- Extraction: local. 2 fps × 1280 px ≈ 0.2 MB per sample on disk (temp);
  a 30-minute file at 2 fps is 3600 samples ≈ 1–2 min of CPU — use the
  coarse pass (`--fps 0.5`) for that, dense passes on windows.
- Vision subagent: ~1–1.5k tokens per frame + prompt; 24 frames ≈ 30k.
  Contact sheet alone ≈ 2k for "roughly what happens"; toast text is not
  reliably legible on it.

## Known limits

- Pixel-based: an embedded video, a scrolling list or a spinner produce forced
  frames every `--force` s and dilute the set.
- Timestamps are sample-aligned (0.5 s at 2 fps).
- Re-encoded GIFs have approximate timing.
- Whisper loops one sentence over silence at the end of a recording; the
  script disables conditioning on previous text, clips to the window and
  dedupes repeats, but still read the tail of `transcript.txt` with that in mind.
- Tests: `uv run --quiet --script scripts/test_video_digest.py` builds a
  synthetic recording (six states + moving cursor) and checks state capture,
  cursor rejection, window timestamps, the cap and `clip`.
