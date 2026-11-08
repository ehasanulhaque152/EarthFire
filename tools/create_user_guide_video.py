"""Build the silent one-minute EarthFire guide and its 30-second README preview.

Requires Pillow and imageio-ffmpeg. Source footage is the existing illustrated
walkthrough in docs/earthfire-walkthrough.mp4.
"""

from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
SOURCE = DOCS / "earthfire-walkthrough.mp4"
FULL = DOCS / "earthfire-user-guide-60s.mp4"
PREVIEW = DOCS / "earthfire-preview-30s.mp4"
CAPTIONS = DOCS / "earthfire-user-guide.vtt"
PREVIEW_CAPTIONS = DOCS / "earthfire-preview-30s.vtt"
PREVIEW_POSTER = DOCS / "earthfire-preview-poster.png"
END_CARD = DOCS / "earthfire-user-guide-end-card.png"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = (
        [Path("C:/Windows/Fonts/arialbd.ttf"), Path("C:/Windows/Fonts/segoeuib.ttf")]
        if bold
        else [Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/segoeui.ttf")]
    )
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def make_end_card() -> None:
    image = Image.new("RGB", (1280, 720), "#071117")
    draw = ImageDraw.Draw(image)
    # Quiet dashboard-inspired grid and accent lights.
    for x in range(0, 1280, 64):
        draw.line((x, 0, x, 720), fill="#0b1b23", width=1)
    for y in range(0, 720, 64):
        draw.line((0, y, 1280, y), fill="#0b1b23", width=1)
    draw.ellipse((850, 105, 1350, 605), fill="#0b202a", outline="#163744", width=3)
    draw.ellipse((915, 170, 1285, 540), outline="#1a5260", width=2)
    draw.ellipse((975, 230, 1225, 480), outline="#246773", width=2)
    draw.arc((915, 170, 1285, 540), 205, 340, fill="#36c4bd", width=5)
    draw.ellipse((1060, 315, 1084, 339), fill="#ff825e")
    draw.ellipse((1150, 390, 1168, 408), fill="#ff825e")
    draw.rounded_rectangle((74, 69, 121, 116), radius=12, fill="#ff825e")
    draw.polygon([(97, 77), (84, 98), (96, 98), (91, 109), (110, 91), (99, 91)], fill="#071117")
    draw.text((139, 70), "earthfire", font=font(40, True), fill="#eef5f6")
    draw.text((74, 181), "READY TO EXPLORE", font=font(19, True), fill="#35c6bf")
    draw.text((74, 220), "Your next view starts here.", font=font(43, True), fill="#f0f5f6")
    draw.text((76, 298), "Choose a region and date to begin.", font=font(24), fill="#a9bdc5")
    steps = [
        "Compare MODIS and VIIRS detections",
        "Select a hotspot for its location details",
        "Use the calendar and trends to explore change",
    ]
    y = 372
    for step in steps:
        draw.ellipse((78, y + 7, 92, y + 21), fill="#ff825e")
        draw.text((110, y), step, font=font(21), fill="#dce8eb")
        y += 55
    draw.rounded_rectangle((74, 596, 470, 649), radius=12, fill="#17313a", outline="#27505a", width=1)
    draw.text((96, 611), "earthfire.onrender.com", font=font(22, True), fill="#35c6bf")
    draw.text((74, 681), "NASA FIRMS observations · Silent product walkthrough", font=font(14), fill="#718b95")
    image.save(END_CARD, optimize=True)


def make_preview_poster() -> None:
    # Use a clean frame from the source video so this generator has no hidden
    # dependency on an older poster asset that may not exist in a fresh clone.
    run(
        "-ss", "12", "-i", str(SOURCE), "-frames:v", "1", "-vf", "scale=1280:720",
        str(PREVIEW_POSTER),
    )
    image = Image.open(PREVIEW_POSTER).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    center = (image.width // 2, image.height // 2)
    draw.ellipse((center[0] - 48, center[1] - 48, center[0] + 48, center[1] + 48), fill=(5, 16, 22, 210), outline=(255, 130, 94, 255), width=3)
    draw.polygon([(center[0] - 12, center[1] - 21), (center[0] - 12, center[1] + 21), (center[0] + 23, center[1])], fill="#ff825e")
    draw.rounded_rectangle((image.width - 155, image.height - 62, image.width - 20, image.height - 20), radius=12, fill=(5, 16, 22, 225), outline=(255, 130, 94, 255), width=1)
    draw.text((image.width - 136, image.height - 54), "30 SEC PREVIEW", font=font(15, True), fill="#eef5f6")
    image = Image.alpha_composite(image, overlay).convert("RGB")
    image.save(PREVIEW_POSTER, optimize=True)


def run(*args: str) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def make_videos() -> None:
    make_end_card()
    # The 36-second walkthrough is paced to 48 seconds, then closes with a
    # 12-second call-to-action, for a total runtime of exactly one minute.
    run(
        "-i", str(SOURCE), "-loop", "1", "-framerate", "15", "-t", "12", "-i", str(END_CARD),
        "-filter_complex",
        "[0:v]setpts=4/3*PTS,fps=15,fade=t=out:st=47.2:d=0.8,format=yuv420p[a];"
        "[1:v]fps=15,fade=t=in:st=0:d=0.8,format=yuv420p[b];"
        "[a][b]concat=n=2:v=1:a=0[out]",
        "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "21",
        "-movflags", "+faststart", str(FULL),
    )
    run(
        "-i", str(FULL), "-t", "30", "-an", "-c:v", "libx264", "-preset", "medium",
        "-crf", "22", "-movflags", "+faststart", str(PREVIEW),
    )


def write_captions() -> None:
    cues = [
        (0, 6, "EarthFire brings NASA FIRMS active-fire observations into one interactive dashboard."),
        (6, 16, "Choose a region and date to focus the globe, metrics, and daily fire calendar."),
        (16, 26, "Select a calendar day to review MODIS and VIIRS detections and occupied cells."),
        (26, 34, "Switch sensor layers to compare hotspots on the interactive 3D globe."),
        (34, 42, "Read the activity trend to see how occupied cells change over time."),
        (42, 48, "The method panel explains how detections share a daily grid."),
        (48, 60, "Start with a region. Explore a hotspot. Follow activity over time."),
    ]

    def stamp(seconds: int) -> str:
        minutes, sec = divmod(seconds, 60)
        return f"00:{minutes:02}:{sec:02}.000"

    text = "WEBVTT\n\n" + "\n\n".join(
        f"{stamp(start)} --> {stamp(end)}\n{caption}" for start, end, caption in cues
    ) + "\n"
    CAPTIONS.write_text(text, encoding="utf-8")
    preview = [(start, min(end, 30), caption) for start, end, caption in cues if start < 30]
    preview_text = "WEBVTT\n\n" + "\n\n".join(
        f"{stamp(start)} --> {stamp(end)}\n{caption}" for start, end, caption in preview
    ) + "\n"
    PREVIEW_CAPTIONS.write_text(preview_text, encoding="utf-8")


if __name__ == "__main__":
    make_videos()
    write_captions()
    make_preview_poster()
    print(f"Created {FULL.name}, {PREVIEW.name}, captions, and the preview poster.")
