#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "imagehash>=4.3", "numpy>=1.26"]
# ///
"""Turn a screen recording into a handful of "something changed" keyframes.

Subcommands
  probe  VIDEO                    duration / size / audio as JSON (plan a window)
  frames VIDEO [--start --end]    keyframes for the whole video or a time window
  clip   VIDEO --start --end      cut a window into a small standalone file

Keyframe logic (UI-recording oriented, not movie scene detection):
  * sample the video at --fps (default 2) scaled to --width
  * a frame is a CHANGE when it differs from the last kept frame by more than
    --change (fraction of pixels that moved, default 0.3 %) or by more than
    --hash-bits in dhash distance
  * a change is only kept once the picture SETTLES (next sample differs from
    it by less than --stable) so we capture the state after the animation,
    not mid-transition; if it never settles, one frame every --force seconds
  * cap at --max frames: first and last always stay, the rest ranked by change
    magnitude, then re-sorted by time

The cap is what keeps the token cost flat: a 30-minute recording produces the
same number of frames as a 90-second one, it just covers it more coarsely.
For a long recording run a coarse pass first, then a dense pass on the window
that matters (--start/--end), see SKILL.md.

Timestamps accept seconds ("95"), "1:35", "01m35s" or "0:01:35" and are
always reported relative to the ORIGINAL video, also inside a window.

Outputs (in --out, default next to the video: <stem>/ or <stem>/w-<from>-<to>/):
  frames/NN-MMmSSs.png    kept frames, numbered in time order
  frames.json             machine-readable index (timestamps, scores, audio flag)
  frames.md               ready-to-paste block for the vision subagent prompt
  contact-sheet.png       optional (--sheet) 4-column overview with timestamps
  transcript.txt          optional (--transcribe) if an audio stream exists and
                          mlx_whisper / whisper CLI is installed
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi", ".gif"}


# --------------------------------------------------------------------------- utils
def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def need(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        die(f"{binary} not found on PATH (brew install ffmpeg)")
    return path


def fmt_ts(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m:02d}m{s:02d}s"


def fmt_clock(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m:02d}:{s:02d}"


def parse_ts(text: str | None) -> float | None:
    """'95' | '95.5' | '1:35' | '0:01:35' | '01m35s' -> seconds."""
    if text is None or text == "":
        return None
    t = text.strip().lower()
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?", t)
    if m and any(m.groups()) and not re.search(r"[:]", t):
        h, mi, s = m.groups()
        return int(h or 0) * 3600 + int(mi or 0) * 60 + float(s or 0)
    parts = t.split(":")
    if all(re.fullmatch(r"\d+(?:\.\d+)?", p) for p in parts) and 1 <= len(parts) <= 3:
        secs = 0.0
        for p in parts:
            secs = secs * 60 + float(p)
        return secs
    die(f"cannot parse timestamp {text!r} (use 95, 1:35, 01m35s or 0:01:35)")


def window_of(args, duration: float) -> tuple[float, float]:
    start = parse_ts(getattr(args, "start", None)) or 0.0
    end = parse_ts(getattr(args, "end", None))
    end = duration if end is None else min(end, duration)
    if start < 0 or start >= end:
        die(f"empty window: start={start:.1f}s end={end:.1f}s (video is {duration:.1f}s)")
    return start, end


# --------------------------------------------------------------------------- ffmpeg
def probe(video: Path) -> dict:
    ffprobe = need("ffprobe")
    res = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(video)],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(res.stdout)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    return {
        "duration": float(info.get("format", {}).get("duration") or v.get("duration") or 0),
        "width": v.get("width"),
        "height": v.get("height"),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "codec": v.get("codec_name"),
    }


def sample_frames(video: Path, tmp: Path, fps: float, width: int, start: float, end: float) -> list[Path]:
    ffmpeg = need("ffmpeg")
    cmd = [ffmpeg, "-v", "error"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(video), "-t", f"{end - start:.3f}",
            "-vf", f"fps={fps},scale={width}:-2:flags=area",
            "-fps_mode", "vfr", str(tmp / "s_%06d.png")]
    subprocess.run(cmd, check=True)
    return sorted(tmp.glob("s_*.png"))


# --------------------------------------------------------------------------- frames
@dataclass
class Frame:
    n: int
    t: float
    file: str
    change: float          # pixel-change fraction vs previous kept frame
    hash_bits: int         # dhash distance vs previous kept frame
    forced: bool = False   # kept because the picture never settled


def load_signals(path: Path, small_w: int = 320):
    from PIL import Image
    import imagehash
    import numpy as np

    img = Image.open(path).convert("L")
    small = img.resize((small_w, max(1, int(img.height * small_w / img.width))), Image.BILINEAR)
    arr = np.asarray(small, dtype=np.int16)
    h = imagehash.dhash(img, hash_size=16)
    return arr, h


def pixel_change(a, b, level: int = 20) -> float:
    import numpy as np
    return float((np.abs(a - b) > level).mean())


def select_keyframes(samples: list[Path], fps: float, change_thr: float, hash_thr: int,
                     stable_thr: float, force_every: float, max_frames: int,
                     t0: float = 0.0) -> list[Frame]:
    if not samples:
        return []
    sig = [load_signals(p) for p in samples]
    kept: list[Frame] = [Frame(0, t0, str(samples[0]), 1.0, 0)]
    last_kept = 0
    pending_since: int | None = None  # index where an unsettled change began

    for i in range(1, len(sig)):
        arr, h = sig[i]
        k_arr, k_h = sig[last_kept]
        d_kept = pixel_change(arr, k_arr)
        bits_kept = h - k_h
        changed = d_kept > change_thr or bits_kept > hash_thr
        if not changed:
            pending_since = None
            continue
        if pending_since is None:
            pending_since = i
        # settled? compare with the NEXT sample (or accept the last sample as settled)
        if i + 1 < len(sig):
            d_next = pixel_change(sig[i + 1][0], arr)
            settled = d_next <= stable_thr
        else:
            settled = True
        forced = (i - pending_since) / fps >= force_every
        if settled or forced:
            kept.append(Frame(i, t0 + i / fps, str(samples[i]), round(d_kept, 4), int(bits_kept), forced and not settled))
            last_kept = i
            pending_since = None

    # make sure the final state is represented
    if kept[-1].n != len(sig) - 1:
        i = len(sig) - 1
        d = pixel_change(sig[i][0], sig[last_kept][0])
        if d > stable_thr:
            kept.append(Frame(i, t0 + i / fps, str(samples[i]), round(d, 4), int(sig[i][1] - sig[last_kept][1])))

    if len(kept) > max_frames:
        first, last = kept[0], kept[-1]
        middle = sorted(kept[1:-1], key=lambda f: (f.change, f.hash_bits), reverse=True)[: max_frames - 2]
        kept = sorted([first, *middle, last], key=lambda f: f.n)
    return kept


def write_contact_sheet(frames: list[Frame], out: Path, cols: int = 4, thumb_w: int = 480) -> None:
    from PIL import Image, ImageDraw

    thumbs = []
    for f in frames:
        im = Image.open(f.file).convert("RGB")
        im = im.resize((thumb_w, int(im.height * thumb_w / im.width)), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        label = f"#{frames.index(f) + 1}  {fmt_clock(f.t)}"
        d.rectangle([0, 0, 8 * len(label) + 12, 22], fill=(0, 0, 0))
        d.text((6, 4), label, fill=(255, 255, 0))
        thumbs.append(im)
    th = max(t.height for t in thumbs)
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * thumb_w + (cols + 1) * 8, rows * th + (rows + 1) * 8), (40, 40, 40))
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        sheet.paste(t, (8 + c * (thumb_w + 8), 8 + r * (th + 8)))
    sheet.save(out, optimize=True)


def transcribe(video: Path, out: Path, start: float, end: float, model: str) -> bool:
    """Narration -> out (txt). Whisper loops on silence, so: no conditioning on
    previous text, hallucination filter, clip to the window, dedupe repeats."""
    ffmpeg = need("ffmpeg")
    wav = out.parent / "audio.wav"
    subprocess.run([ffmpeg, "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(video), "-t", f"{end - start:.3f}",
                    "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True)
    if shutil.which("mlx_whisper"):
        cmd = ["mlx_whisper", str(wav), "--model", model, "--output-dir", str(out.parent),
               "--output-format", "txt", "--output-name", out.stem,
               "--condition-on-previous-text", "False", "--hallucination-silence-threshold", "2",
               "--clip-timestamps", f"0,{end - start:.1f}"]
    elif shutil.which("whisper"):
        cmd = ["whisper", str(wav), "--output_dir", str(out.parent), "--output_format", "txt",
               "--condition_on_previous_text", "False", "--hallucination_silence_threshold", "2"]
    else:
        print("transcribe: neither mlx_whisper nor whisper CLI found; skipping (uv tool install mlx-whisper)", file=sys.stderr)
        wav.unlink(missing_ok=True)
        return False
    subprocess.run(cmd, check=True, capture_output=True)
    wav.unlink(missing_ok=True)
    if not out.exists():
        return False
    lines, kept = [l.strip() for l in out.read_text().splitlines()], []
    for l in lines:
        if l and l != "!" and (not kept or l != kept[-1]):
            kept.append(l)
    out.write_text("\n".join(kept) + "\n")
    return True


def default_out(video: Path, start: float, end: float, duration: float) -> Path:
    base = video.parent / video.stem
    if start > 0 or end < duration - 0.5:
        return base / f"w-{fmt_ts(start)}-{fmt_ts(end)}"
    return base


def cmd_frames(args) -> Path:
    video = Path(args.video).expanduser().resolve()
    if not video.exists():
        die(f"no such file: {video}")
    need("ffmpeg")
    info = probe(video)
    start, end = window_of(args, info["duration"])
    windowed = start > 0 or end < info["duration"] - 0.5
    out_dir = Path(args.out).expanduser().resolve() if args.out else default_out(video, start, end, info["duration"])
    frames_dir = out_dir / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)

    with tempfile.TemporaryDirectory(prefix="video-digest-") as tmp:
        samples = sample_frames(video, Path(tmp), args.fps, args.width, start, end)
        kept = select_keyframes(samples, args.fps, args.change, args.hash_bits,
                                args.stable, args.force, args.max, t0=start)
        for idx, f in enumerate(kept, start=1):
            dest = frames_dir / f"{idx:02d}-{fmt_ts(f.t)}.png"
            shutil.copy2(f.file, dest)
            f.file = str(dest)

    index = {
        "video": str(video),
        "duration_s": round(info["duration"], 1),
        "window_s": [round(start, 1), round(end, 1)],
        "source_size": [info["width"], info["height"]],
        "has_audio": info["has_audio"],
        "sampled_fps": args.fps,
        "samples": len(samples),
        "frame_width": args.width,
        "thresholds": {"change": args.change, "hash_bits": args.hash_bits, "stable": args.stable,
                       "force_every_s": args.force, "max": args.max},
        "capped": len(samples) > 0 and len(kept) >= args.max,
        "frames": [asdict(f) for f in kept],
    }
    (out_dir / "frames.json").write_text(json.dumps(index, indent=2))

    span = f"window {fmt_clock(start)}–{fmt_clock(end)} of a {fmt_clock(info['duration'])} video" if windowed \
        else f"{fmt_clock(info['duration'])} long"
    md = [f"Video: `{video.name}` — {span}, {info['width']}x{info['height']}, "
          f"{'has audio' if info['has_audio'] else 'no audio'}. {len(kept)} keyframes (state changes), time order:", ""]
    for idx, f in enumerate(kept, start=1):
        note = " (unsettled, mid-animation)" if f.forced else ""
        md.append(f"{idx}. {fmt_clock(f.t)} — `{f.file}`{note}")
    if index["capped"]:
        md += ["", f"Note: hit the {args.max}-frame cap; smaller changes between these frames were dropped."]
    if args.sheet and kept:
        sheet = out_dir / "contact-sheet.png"
        write_contact_sheet(kept, sheet)
        md += ["", f"Contact sheet (all frames, numbered): `{sheet}`"]
    if args.transcribe and info["has_audio"]:
        t = out_dir / "transcript.txt"
        if transcribe(video, t, start, end, args.whisper_model):
            md += ["", "Transcript of the narration:", "", "```", t.read_text().strip(), "```"]
    (out_dir / "frames.md").write_text("\n".join(md) + "\n")

    print(f"{len(kept)} keyframes from {len(samples)} samples ({fmt_clock(start)}–{fmt_clock(end)}) -> {frames_dir}")
    for idx, f in enumerate(kept, start=1):
        flag = " forced" if f.forced else ""
        print(f"  {idx:02d}  {fmt_clock(f.t)}  change={f.change:.3%}  bits={f.hash_bits}{flag}")
    if index["capped"]:
        print(f"capped at --max {args.max}: narrow the window (--start/--end) or raise --max")
    print(f"prompt block: {out_dir / 'frames.md'}")
    return out_dir


def cmd_probe(args) -> None:
    video = Path(args.video).expanduser().resolve()
    if not video.exists():
        die(f"no such file: {video}")
    info = probe(video)
    info["duration_clock"] = fmt_clock(info["duration"])
    info["video"] = str(video)
    print(json.dumps(info, indent=2))


def cmd_clip(args) -> None:
    video = Path(args.video).expanduser().resolve()
    if not video.exists():
        die(f"no such file: {video}")
    ffmpeg = need("ffmpeg")
    info = probe(video)
    start, end = window_of(args, info["duration"])
    out = Path(args.out).expanduser().resolve() if args.out else \
        video.parent / f"{video.stem}-{fmt_ts(start)}-{fmt_ts(end)}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(video), "-t", f"{end - start:.3f}",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd += ["-c:a", "aac"] if info["has_audio"] else ["-an"]
    cmd.append(str(out))
    subprocess.run(cmd, check=True)
    print(f"clip {fmt_clock(start)}–{fmt_clock(end)} -> {out}  ({out.stat().st_size // 1024} KB)")


# --------------------------------------------------------------------------- cli
def add_window_opts(p: argparse.ArgumentParser) -> None:
    p.add_argument("--start", help="window start (95, 1:35, 01m35s); default 0")
    p.add_argument("--end", help="window end; default end of video")


def add_frame_opts(p: argparse.ArgumentParser) -> None:
    p.add_argument("--fps", type=float, default=2, help="sampling rate (default 2; use 0.5–1 for a coarse pass on a long video)")
    p.add_argument("--width", type=int, default=1280, help="frame width for the model (default 1280)")
    p.add_argument("--change", type=float, default=0.003, help="pixel-change fraction that counts as a change (default 0.3%%)")
    p.add_argument("--hash-bits", type=int, default=8, help="dhash distance that counts as a change (default 8 of 256)")
    p.add_argument("--stable", type=float, default=0.001, help="pixel-change fraction under which the picture is 'settled'")
    p.add_argument("--force", type=float, default=4.0, help="seconds of continuous motion before a frame is kept anyway")
    p.add_argument("--max", type=int, default=24, help="max keyframes (first/last always kept)")
    p.add_argument("--sheet", action="store_true", help="also write contact-sheet.png")
    p.add_argument("--transcribe", action="store_true", help="transcribe narration if there is audio and a whisper CLI")
    p.add_argument("--whisper-model", default="mlx-community/whisper-large-v3-turbo",
                   help="mlx_whisper model (default large-v3-turbo, ~1.6 GB on first use)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    pp = sub.add_parser("probe", help="print duration / size / audio as JSON")
    pp.add_argument("video")
    pp.set_defaults(func=cmd_probe)

    pr = sub.add_parser("frames", help="extract keyframes from a video file (whole or a window)")
    pr.add_argument("video")
    pr.add_argument("--out", help="output dir (default next to the video, named after it)")
    add_window_opts(pr)
    add_frame_opts(pr)
    pr.set_defaults(func=cmd_frames)

    pc = sub.add_parser("clip", help="cut a window into a small standalone mp4")
    pc.add_argument("video")
    pc.add_argument("--out", help="output file (default <video>-<from>-<to>.mp4 next to the source)")
    add_window_opts(pc)
    pc.set_defaults(func=cmd_clip)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
