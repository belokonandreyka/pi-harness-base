#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "imagehash>=4.3", "numpy>=1.26"]
# ///
"""uv run --quiet --script scripts/test_video_digest.py  (from the skill dir; needs ffmpeg)

Builds a synthetic 18 s "screen recording": a white page, a new box appears every
3 s (six states), plus a small cursor that never stops moving. Checks that the
extractor keeps one frame per state and ignores the cursor, that a window
reports original-video timestamps, that the cap holds, and that clip works.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import video_digest as vd  # noqa: E402

STATES = 6          # t=0 plain, then boxes at 3,6,9,12,15
STEP = 3
DURATION = STATES * STEP


def make_synthetic(path: Path) -> None:
    boxes = []
    for i in range(1, STATES):
        boxes.append(f"drawbox=enable='gte(t,{i * STEP})':x={40 + i * 90}:y=80:w=70:h=50:color=black@1:t=fill")
    cursor = "drawbox=x='mod(t*40,600)':y='100+mod(t*25,200)':w=8:h=8:color=red@1:t=fill"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=white:s=640x360:d={DURATION}:r=10",
         "-vf", ",".join(boxes + [cursor]), "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(Path(__file__).parent / "video_digest.py"), *args],
                          capture_output=True, text=True)


class VideoDigestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg"):
            raise unittest.SkipTest("ffmpeg not installed")
        cls.tmp = Path(tempfile.mkdtemp(prefix="vd-test-"))
        cls.video = cls.tmp / "rec.mp4"
        make_synthetic(cls.video)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def frames_json(self, out: Path) -> dict:
        return json.loads((out / "frames.json").read_text())

    def test_parse_ts(self):
        self.assertEqual(vd.parse_ts("95"), 95)
        self.assertEqual(vd.parse_ts("1:35"), 95)
        self.assertEqual(vd.parse_ts("0:01:35"), 95)
        self.assertEqual(vd.parse_ts("01m35s"), 95)
        self.assertEqual(vd.parse_ts("2m"), 120)
        self.assertIsNone(vd.parse_ts(None))

    def test_whole_video_one_frame_per_state_cursor_ignored(self):
        out = self.tmp / "whole"
        res = run("frames", str(self.video), "--out", str(out), "--sheet")
        self.assertEqual(res.returncode, 0, res.stderr)
        idx = self.frames_json(out)
        times = [round(f["t"]) for f in idx["frames"]]
        self.assertEqual(len(times), STATES, times)
        # each state is captured right after its change settled (within one sample)
        for i, t in enumerate(times):
            self.assertLessEqual(abs(t - i * STEP), 1, times)
        self.assertFalse(any(f["forced"] for f in idx["frames"]))
        self.assertFalse(idx["capped"])
        self.assertTrue((out / "contact-sheet.png").exists())
        self.assertIn("6 keyframes", (out / "frames.md").read_text())

    def test_window_keeps_original_timestamps(self):
        out = self.tmp / "win"
        res = run("frames", str(self.video), "--start", "0:08", "--end", "14", "--out", str(out))
        self.assertEqual(res.returncode, 0, res.stderr)
        idx = self.frames_json(out)
        self.assertEqual(idx["window_s"], [8.0, 14.0])
        times = [round(f["t"]) for f in idx["frames"]]
        self.assertEqual(times[0], 8, times)
        self.assertTrue(all(8 <= t <= 14 for t in times), times)
        self.assertEqual(len(times), 3, times)   # state at 8, change at 9, change at 12
        self.assertIn("window 00:08", (out / "frames.md").read_text())

    def test_default_window_dir_name(self):
        res = run("frames", str(self.video), "--start", "3", "--end", "9")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue((self.video.parent / "rec" / "w-00m03s-00m09s" / "frames.json").exists())

    def test_cap_keeps_first_and_last(self):
        out = self.tmp / "cap"
        res = run("frames", str(self.video), "--max", "3", "--out", str(out))
        self.assertEqual(res.returncode, 0, res.stderr)
        idx = self.frames_json(out)
        times = [round(f["t"]) for f in idx["frames"]]
        self.assertEqual(len(times), 3, times)
        self.assertEqual(times[0], 0)
        self.assertGreaterEqual(times[-1], 15)
        self.assertTrue(idx["capped"])
        self.assertIn("capped", res.stdout)

    def test_clip_and_probe(self):
        clip = self.tmp / "clip.mp4"
        res = run("clip", str(self.video), "--start", "5", "--end", "11", "--out", str(clip))
        self.assertEqual(res.returncode, 0, res.stderr)
        info = json.loads(run("probe", str(clip)).stdout)
        self.assertAlmostEqual(info["duration"], 6, delta=0.3)
        self.assertFalse(info["has_audio"])

    def test_bad_window(self):
        res = run("frames", str(self.video), "--start", "10", "--end", "5")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("empty window", res.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
