#!/usr/bin/env python3
"""Render the installer artwork from the app's design tokens.

The installers cannot run the web UI, so the pieces Windows and Finder can't
draw natively (buttons, switches, the WiX and DMG backdrops) are rendered here
with the same colours, radii, sizes and Inter font the app uses
(web-app/src/index.css, components/ui/button.tsx and switch.tsx). The output
is committed, so building an installer never needs Pillow; rerun this after
changing the tokens below:

    pip install pillow && python3 src-tauri/installer/generate.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent.parent / "web-app" / "public" / "fonts" / "inter"
SS = 4  # supersampling factor, for anti-aliased edges in the BMPs

# Tokens copied from web-app/src/index.css (:root and .dark).
THEMES = {
    "light": {
        "background": "#F8F8F8",
        "foreground": "#1F2937",
        "card": "#FFFFFF",
        "secondary_fg": "#4B5563",
        "muted_fg": "#6B7280",
        "border": "#E5E7EB",
        "grad": ("#37475D", "#1F2937"),
        "on_grad": "#FFFFFF",
        "primary_border": "#1F2937",
        "destructive": "#EF4444",
        "destructive_tint": "#FDECEC",  # destructive at 12% over background
        "cb": "#E1E4EA",
        "knob": "#FFFFFF",
    },
    "dark": {
        "background": "#0A0B0D",
        "foreground": "#E6E8EB",
        "card": "#131519",
        "secondary_fg": "#B3B9C2",
        "muted_fg": "#8A909A",
        "border": "#23262C",
        "grad": ("#FFFFFF", "#D9DDE3"),
        "on_grad": "#111318",
        "primary_border": "#E6E8EB",
        "destructive": "#F87171",
        "destructive_tint": "#27171A",  # destructive at 12% over background
        "cb": "#2A2E35",
        "knob": "#111318",  # the checked knob uses --on-grad in dark
    },
}

# The scales the NSIS script snaps the monitor DPI to.
SCALES = (100, 125, 150, 200)


def rgb(hex_):
    hex_ = hex_.lstrip("#")
    return tuple(int(hex_[i : i + 2], 16) for i in (0, 2, 4))


def font(weight, px):
    return ImageFont.truetype(str(FONTS / f"Inter_18pt-{weight}.ttf"), px)


def vgrad(size, top, bottom, stop=0.64697):
    """The app's --grad: top colour to bottom colour, reached at 64.697%."""
    w, h = size
    img = Image.new("RGB", size)
    a, b = rgb(top), rgb(bottom)
    px = img.load()
    for y in range(h):
        t = min(1.0, y / max(1, (h - 1) * stop))
        c = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return m


def button(theme, variant, label, scale):
    """A `size="lg"` Flint button: 36px tall, 14px padding, 13px medium, 8px radius."""
    t = THEMES[theme]
    s = scale / 100 * SS
    f = font("Medium", round(13 * s))
    tw = f.getbbox(label)[2]
    w = max(round(88 * s), tw + round(28 * s))
    h = round(36 * s)
    r = round(8 * s)
    bw = max(1, round(0.8 * s)) if variant != "primary" else max(1, round(1 * s))

    img = Image.new("RGB", (w, h), rgb(t["background"]))
    if variant == "primary":
        border, fill, fg = t["primary_border"], vgrad((w, h), *t["grad"]), t["on_grad"]
    elif variant == "destructive":
        border, fill, fg = t["destructive_tint"], Image.new("RGB", (w, h), rgb(t["destructive_tint"])), t["destructive"]
    else:  # outline
        border, fill, fg = t["border"], Image.new("RGB", (w, h), rgb(t["card"])), t["secondary_fg"]

    img.paste(Image.new("RGB", (w, h), rgb(border)), (0, 0), rounded_mask((w, h), r))
    inner = (w - 2 * bw, h - 2 * bw)
    img.paste(fill.crop((bw, bw, bw + inner[0], bw + inner[1])), (bw, bw), rounded_mask(inner, max(0, r - bw)))

    d = ImageDraw.Draw(img)
    d.text((w / 2, h / 2), label, font=f, fill=rgb(fg), anchor="mm")
    return img.resize((int(w / SS + 0.5), int(h / SS + 0.5)), Image.LANCZOS)


def switch(theme, on, scale):
    """The app's switch: 30x18 track, 14px knob, 2px inset."""
    t = THEMES[theme]
    s = scale / 100 * SS
    w, h = round(30 * s), round(18 * s)
    img = Image.new("RGB", (w, h), rgb(t["background"]))
    track = vgrad((w, h), *t["grad"]) if on else Image.new("RGB", (w, h), rgb(t["cb"]))
    img.paste(track, (0, 0), rounded_mask((w, h), h // 2))
    k, p = round(14 * s), round(2 * s)
    x = w - p - k if on else p
    knob = t["knob"] if (on or theme == "light") else "#E6E8EB"
    ImageDraw.Draw(img).ellipse((x, p, x + k - 1, p + k - 1), fill=rgb(knob))
    return img.resize((int(w / SS + 0.5), int(h / SS + 0.5)), Image.LANCZOS)


def windows_assets():
    out = HERE / "windows"
    # flint-ui.nsh lays these out from their 1x size times the scale.
    for scale in SCALES:
        for img, base in ((button("dark", "destructive", "Uninstall", scale), (88, 36)),
                          (button("dark", "outline", "Cancel", scale), (88, 36)),
                          (switch("dark", True, scale), (30, 18))):
            assert img.size == tuple((v * scale + 50) // 100 for v in base), (scale, img.size)
    for theme in THEMES:
        for scale in SCALES:
            d = out / theme / str(scale)
            d.mkdir(parents=True, exist_ok=True)
            button(theme, "destructive", "Uninstall", scale).save(d / "btn-uninstall.bmp")
            button(theme, "outline", "Cancel", scale).save(d / "btn-cancel.bmp")
            switch(theme, True, scale).save(d / "switch-on.bmp")
            switch(theme, False, scale).save(d / "switch-off.bmp")


def logo(size):
    icon = Image.open(HERE.parent / "icons" / "icon.png").convert("RGBA")
    return icon.resize((size, size), Image.LANCZOS)


def wix_assets():
    """WiX draws black text on these, so they use the light theme."""
    t = THEMES["light"]
    out = HERE / "wix"
    out.mkdir(parents=True, exist_ok=True)

    # 493x58 banner above the inner pages; WiX puts its title on the left.
    banner = Image.new("RGB", (493, 58), rgb(t["card"]))
    ImageDraw.Draw(banner).line((0, 57, 493, 57), fill=rgb(t["border"]))
    banner.paste(logo(32), (493 - 32 - 16, 13), logo(32))
    banner.save(out / "banner.bmp")

    # 493x312 welcome/finish backdrop; WiX writes its text from x=180.
    dialog = Image.new("RGB", (493, 312), rgb(t["card"]))
    d = ImageDraw.Draw(dialog)
    d.rectangle((0, 0, 164, 312), fill=rgb(t["background"]))
    d.line((164, 0, 164, 312), fill=rgb(t["border"]))
    dialog.paste(logo(56), (54, 40), logo(56))
    d.text((82, 116), "Flint", font=font("SemiBold", 18), fill=rgb(t["foreground"]), anchor="mm")
    dialog.save(out / "dialog.bmp")


def dmg_assets():
    """660x400 Finder backdrop; the app sits at (180, 190), Applications at (480, 190)."""
    t = THEMES["light"]
    out = HERE / "dmg"
    out.mkdir(parents=True, exist_ok=True)
    w, h = 660 * SS, 400 * SS
    img = Image.new("RGB", (w, h), rgb(t["background"]))
    d = ImageDraw.Draw(img)
    # Two cards the icons land on, like the app's settings cards.
    for cx in (180, 480):
        box = ((cx - 90) * SS, 100 * SS, (cx + 90) * SS, 290 * SS)
        d.rounded_rectangle(box, 12 * SS, fill=rgb(t["card"]), outline=rgb(t["border"]), width=SS)
    # Arrow between them.
    y = 190 * SS
    d.line((290 * SS, y, 366 * SS, y), fill=rgb(t["muted_fg"]), width=2 * SS)
    d.polygon([(370 * SS, y), (360 * SS, y - 6 * SS), (360 * SS, y + 6 * SS)], fill=rgb(t["muted_fg"]))
    d.text((330 * SS, 52 * SS), "Drag Flint to Applications to install", font=font("Medium", 13 * SS),
           fill=rgb(t["secondary_fg"]), anchor="mm")
    img = img.resize((660, 400), Image.LANCZOS)
    img.save(out / "background.png")


if __name__ == "__main__":
    windows_assets()
    wix_assets()
    dmg_assets()
    print("installer assets written to", HERE)
