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
        "fg2": "#374151",
        "muted": "#F6F6F6",
        "secondary_fg": "#4B5563",
        "muted_fg": "#6B7280",
        "border": "#E5E7EB",
        "grad": ("#37475D", "#1F2937"),
        "on_grad": "#FFFFFF",
        "primary_border": "#1F2937",
        "destructive": "#EF4444",
        "destructive_tint": "#FDECEC",  # destructive at 12% over background
        "border_strong": "#D1D5DB",
        "cb": "#E1E4EA",
        "knob": "#FFFFFF",
    },
    "dark": {
        "background": "#0A0B0D",
        "foreground": "#E6E8EB",
        "card": "#131519",
        "fg2": "#C9CED6",
        "muted": "#0F1114",
        "secondary_fg": "#B3B9C2",
        "muted_fg": "#8A909A",
        "border": "#23262C",
        "grad": ("#FFFFFF", "#D9DDE3"),
        "on_grad": "#111318",
        "primary_border": "#E6E8EB",
        "destructive": "#F87171",
        "destructive_tint": "#27171A",  # destructive at 12% over background
        "border_strong": "#353A42",
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


# ---------------------------------------------------------------------------
# Text. Labels baked into bitmaps are rasterised by Windows GDI with ClearType
# and the font's own hinting, exactly like the live text in the wizard, so they
# look the same next to it. (Pillow's grayscale, unhinted text looks soft beside
# it, and so does GDI's own grayscale mode.) Off Windows this falls back to Pillow.
# ---------------------------------------------------------------------------
import ctypes
import sys

FACES = {"Regular": ("Inter 18pt", 400), "Medium": ("Inter 18pt Medium", 500), "SemiBold": ("Inter 18pt SemiBold", 600)}
_loaded = set()


class _Size(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


class _BmiHeader(ctypes.Structure):
    _fields_ = [("size", ctypes.c_uint32), ("w", ctypes.c_int32), ("h", ctypes.c_int32), ("planes", ctypes.c_uint16),
                ("bpp", ctypes.c_uint16), ("comp", ctypes.c_uint32), ("img", ctypes.c_uint32), ("xppm", ctypes.c_int32),
                ("yppm", ctypes.c_int32), ("used", ctypes.c_uint32), ("imp", ctypes.c_uint32)]


def _gdi():
    if sys.platform != "win32":
        return None
    g = ctypes.windll.gdi32
    g.CreateFontW.restype = ctypes.c_void_p
    g.CreateCompatibleDC.restype = ctypes.c_void_p
    g.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    g.SelectObject.restype = ctypes.c_void_p
    g.CreateDIBSection.restype = ctypes.c_void_p
    g.CreateDIBSection.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_uint]
    g.DeleteObject.argtypes = [ctypes.c_void_p]
    g.DeleteDC.argtypes = [ctypes.c_void_p]
    g.GetTextExtentPoint32W.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int, ctypes.POINTER(_Size)]
    g.TextOutW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p, ctypes.c_int]
    g.SetBkColor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    g.SetTextColor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    g.SetBkMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
    return g


def _load_faces():
    g = _gdi()
    for weight in FACES:
        if weight not in _loaded:
            g.AddFontResourceExW(str(FONTS / f"Inter_18pt-{weight}.ttf"), 0x10, 0)  # FR_PRIVATE
            _loaded.add(weight)


def text_width(text, weight, px):
    """Width in px of `text` as GDI sets it."""
    g = _gdi()
    if g is None:
        return font(weight, px).getlength(text)
    _load_faces()
    face, w = FACES[weight]
    hdc = g.CreateCompatibleDC(None)
    hf = g.CreateFontW(-px, 0, 0, 0, w, 0, 0, 0, 1, 0, 0, 5, 0, face)
    old = g.SelectObject(hdc, hf)
    size = _Size()
    g.GetTextExtentPoint32W(hdc, text, len(text), ctypes.byref(size))
    g.SelectObject(hdc, old)
    g.DeleteObject(hf)
    g.DeleteDC(hdc)
    return size.cx


def draw_text(img, xy, text, weight, px, fill, center=False):
    """Draw `text` on `img` with hinted GDI text: `xy` is the top-left, or the centre when `center`."""
    g = _gdi()
    if g is None:
        f = font(weight, px)
        ImageDraw.Draw(img).text(xy, text, font=f, fill=fill, anchor="mm" if center else "la")
        return
    _load_faces()
    face, w = FACES[weight]
    hdc = g.CreateCompatibleDC(None)
    hf = g.CreateFontW(-px, 0, 0, 0, w, 0, 0, 0, 1, 0, 0, 5, 0, face)  # CLEARTYPE_QUALITY
    old = g.SelectObject(hdc, hf)
    size = _Size()
    g.GetTextExtentPoint32W(hdc, text, len(text), ctypes.byref(size))
    pad = 2
    tw, th = size.cx + 2 * pad, size.cy + 2 * pad
    bmi = _BmiHeader(ctypes.sizeof(_BmiHeader), tw, -th, 1, 32, 0, 0, 0, 0, 0, 0)
    bits = ctypes.c_void_p()
    hbm = g.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    old_bm = g.SelectObject(hdc, hbm)
    g.SetBkMode(hdc, 2)  # OPAQUE
    g.SetBkColor(hdc, 0)
    g.SetTextColor(hdc, 0xFFFFFF)
    g.TextOutW(hdc, pad, pad, text, len(text))
    raw = ctypes.string_at(bits, tw * th * 4)
    cover = Image.frombuffer("RGB", (tw, th), raw, "raw", "BGRX", 0, 1)  # per-channel ClearType coverage
    g.SelectObject(hdc, old_bm)
    g.DeleteObject(hbm)
    g.SelectObject(hdc, old)
    g.DeleteObject(hf)
    g.DeleteDC(hdc)
    x, y = xy
    if center:
        x, y = x - size.cx / 2, y - size.cy / 2
    x, y = round(x) - pad, round(y) - pad
    region = img.crop((x, y, x + tw, y + th))
    # Blend each channel with its own coverage: that is what ClearType does on screen.
    chans = [Image.composite(Image.new("L", (tw, th), fill[i]), region.getchannel(i), cover.getchannel(i)) for i in range(3)]
    img.paste(Image.merge("RGB", chans), (x, y))


# Buttons that sit beside an input use the app's default size (32px, 12px text)
# so they are as tall as the input; every other button is `size="lg"`.
SMALL_BUTTONS = {"browse"}


def button_width(label, small=False):
    """The 1x width of a button: `size="lg"` is the label plus 14px padding, at least 88px;
    the default size is the label plus 10px padding."""
    if small:
        return (text_width(label, "Medium", 12) + 20 + 1) // 2 * 2
    return max(88, text_width(label, "Medium", 13) + 28)


def button(theme, variant, label, scale, width=None, small=False):
    """A `size="lg"` Flint button: 36px tall, 14px padding, 13px medium, 8px radius.
    With `small`, the default size: 32px tall, 12px medium.

    `width` (1x px) pins the width so every scale of one button has the same
    proportions; without it the width follows the label, as in the app.
    """
    t = THEMES[theme]
    s = scale / 100 * SS
    f = font("Medium", round(13 * s))
    tw = f.getbbox(label)[2]
    w = max(round(88 * s), tw + round(28 * s))
    if width is not None:
        w = round(((width * scale + 50) // 100) * SS)
    h = round((32 if small else 36) * s)
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

    out = img.resize((int(w / SS + 0.5), int(h / SS + 0.5)), Image.LANCZOS)
    # The label is drawn after the shrink, at its real pixel size, so the
    # hinted outlines land on whole pixels: text shrunk from 4x looks soft.
    draw_text(out, (out.width / 2, out.height / 2), label, "Medium", max(1, round((12 if small else 13) * scale / 100)), rgb(fg), center=True)
    return out


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


# Every button the wizard draws: (variant, file slug, label). Cancel is the
# outline button the uninstall page already uses; "Uninstall" stays destructive.
WIZARD_BUTTONS = (
    ("primary", "continue", "Continue"),
    ("primary", "install", "Install"),
    ("primary", "launch", "Launch Flint"),
    ("primary", "finish", "Finish"),
    ("primary", "close", "Close"),
    ("outline", "cancel", "Cancel"),
    ("outline", "back", "Back"),
    ("outline", "browse", "Browse"),
    ("outline", "close", "Close"),
)

def input_w():
    """Install-location field: the 424px column minus the Browse button and an 8px gap."""
    return 424 - 8 - button_width("Browse", small=True)

INPUT_H = 32


def field(theme, width, scale):
    """The app's Input: 32px tall, 8px radius, 0.8px --border, --card fill."""
    t = THEMES[theme]
    s = scale / 100 * SS
    w = round(((width * scale + 50) // 100) * SS)
    h = round(((INPUT_H * scale + 50) // 100) * SS)
    r = round(8 * s)
    bw = max(1, round(0.8 * s))
    img = Image.new("RGB", (w, h), rgb(t["background"]))
    img.paste(Image.new("RGB", (w, h), rgb(t["border"])), (0, 0), rounded_mask((w, h), r))
    inner = (w - 2 * bw, h - 2 * bw)
    img.paste(Image.new("RGB", inner, rgb(t["card"])), (bw, bw), rounded_mask(inner, max(0, r - bw)))
    return img.resize((int(w / SS + 0.5), int(h / SS + 0.5)), Image.LANCZOS)


def radio(theme, on, scale):
    """The app's RadioGroupItem: 16px circle, --border-strong ring on --card; checked is a solid --primary disc."""
    t = THEMES[theme]
    s = scale / 100 * SS
    d = round(((16 * scale + 50) // 100) * SS)
    img = Image.new("RGB", (d, d), rgb(t["background"]))
    draw = ImageDraw.Draw(img)
    if on:
        draw.ellipse((0, 0, d - 1, d - 1), fill=rgb(t["primary_border"]))
    else:
        bw = max(1, round(1 * s))
        draw.ellipse((0, 0, d - 1, d - 1), fill=rgb(t["border_strong"]))
        draw.ellipse((bw, bw, d - 1 - bw, d - 1 - bw), fill=rgb(t["card"]))
    return img.resize((int(d / SS + 0.5), int(d / SS + 0.5)), Image.LANCZOS)


def wizard_assets():
    """Buttons, the path field and the radio dots for the custom install wizard."""
    out = HERE / "windows"
    lines = [
        "; Generated by src-tauri/installer/generate.py. Do not edit.",
        "; 1x pixel sizes of the wizard bitmaps, and the macro that embeds them.",
        "",
    ]
    for variant, slug, label in WIZARD_BUTTONS:
        small = slug in SMALL_BUTTONS
        lines.append(f"!define FLINT_BTN_W_{variant}_{slug} {button_width(label, small)}")
        lines.append(f"!define FLINT_BTN_H_{variant}_{slug} {32 if small else 36}")
    lines += [f"!define FLINT_FIELD_W {input_w()}", f"!define FLINT_FIELD_H {INPUT_H}", f"!define FLINT_EDIT_W {input_w() - 22}", "", "!macro _FlintExtractWizard theme scale"]
    bs = "\\"
    names = [f"btn-{variant}-{slug}" for variant, slug, _ in WIZARD_BUTTONS] + ["field", "radio-on", "radio-off"]
    for name in names:
        dest = bs.join(["$PLUGINSDIR", "flint", "${theme}", "${scale}", f"{name}.bmp"])
        src = bs.join(["${FLINT_UI}", "${theme}", "${scale}", f"{name}.bmp"])
        lines.append(f'  File "/oname={dest}" "{src}"')
    lines.append("!macroend")
    (out / "flint-ui-assets.nsh").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    for theme in THEMES:
        for scale in SCALES:
            d = out / theme / str(scale)
            d.mkdir(parents=True, exist_ok=True)
            for variant, slug, label in WIZARD_BUTTONS:
                small = slug in SMALL_BUTTONS
                button(theme, variant, label, scale, width=button_width(label, small), small=small).save(d / f"btn-{variant}-{slug}.bmp")
            field(theme, input_w(), scale).save(d / "field.bmp")
            radio(theme, True, scale).save(d / "radio-on.bmp")
            radio(theme, False, scale).save(d / "radio-off.bmp")

# ---------------------------------------------------------------------------
# MSI. Windows Installer draws its own dialogs, so the page look is a full-size
# bitmap per page (same tokens, same Inter face as the NSIS wizard) with native
# controls only where a page needs live text: the install path, the progress
# bar and its status line. Buttons are the app Button rendered to bitmaps.
#
# The MSI is light only. A push button always draws Windows' light 3D frame, and
# on hover around every button of the dialog; on the light page that frame is
# nearly invisible, on a dark one it is a bright rectangle around each button.
# Everything is drawn at 1x, the size it is shown at: Windows Installer stretches
# a page bitmap with nearest neighbour, so a larger source would alias.
# ---------------------------------------------------------------------------
MSI_THEME = "light"
MSI_S = 1
MSI_W, MSI_H = 493, 360          # 370 x 270 dialog units at 96 dpi
MSI_RAIL = 158
MSI_X = 182                       # right column
MSI_COL = 287

MSI_PAGES = {
    "welcome": dict(
        title="Install Flint",
        sub="Your local AI workspace, ready in minutes.",
        body=["Flint runs locally on your computer for chats, coding and agent workflows — with the models and providers you choose."],
        bullets=["Private by default", "Local-first and under your control", "Bring your own models"],
    ),
    "installdir": dict(
        title="Choose where to install",
        sub="Pick where Flint should live.",
        label="Install location",
        note="The bundled local runtime and tools are installed with Flint.",
    ),
    "progress": dict(
        title="Installing Flint",
        sub="Setting up your local AI workspace. This should only take a moment.",
    ),
    "exit": dict(
        title="Flint is ready",
        sub="Setup is complete. Flint has been installed successfully.",
        body=["You can add models, providers and finish any first-run setup after Flint opens."],
    ),
    "remove": dict(
        title="Uninstall Flint",
        sub="Remove Flint from this computer.",
        body=["Your chats, models and settings stay on this computer unless you delete them yourself."],
    ),
    "removing": dict(
        title="Uninstalling Flint",
        sub="Removing Flint from this computer.",
    ),
    "fatal": dict(
        title="Setup didn't finish",
        sub="Something went wrong, so setup rolled back its changes.",
        body=["Flint was not installed. You can close this window and run setup again."],
    ),
    "removed": dict(
        title="Flint was removed",
        sub="Uninstallation completed successfully.",
        body=["The Flint application has been removed from this computer."],
    ),
    "filesinuse": dict(
        title="Flint is running",
        sub="Close the applications below, then choose Retry.",
    ),
    "userexit": dict(
        title="Setup was cancelled",
        sub="Nothing was changed on this computer.",
        body=["Run the installer again whenever you want to install Flint."],
    ),
}

# The small modal dialogs (cancel confirmation, errors) have no rail.
MSI_SMALL = {
    "cancel": dict(w=352, h=140, title="Cancel setup?", body="Are you sure you want to cancel the installation?"),
}

MSI_BUTTONS = (
    ("primary", "continue", "Continue"),
    ("primary", "install", "Install"),
    ("primary", "launch", "Launch Flint"),
    ("primary", "close", "Close"),
    ("primary", "ok", "OK"),
    ("primary", "retry", "Retry"),
    ("primary", "yes", "Yes"),
    ("primary", "no", "No"),
    ("outline", "cancel", "Cancel"),
    ("outline", "back", "Back"),
    ("outline", "close", "Close"),
    ("outline", "yes", "Yes"),
    ("outline", "no", "No"),
    ("outline", "ignore", "Ignore"),
    ("outline", "exit", "Exit"),
    ("outline", "browse", "Browse"),
    ("destructive", "uninstall", "Uninstall"),
)
MSI_SMALL_SLUGS = {"browse"}  # the app default button size, 32px tall


def wrap(text, weight, px, width):
    """Greedy word wrap using GDI text widths; returns the lines."""
    lines, cur = [], ""
    for word in text.split(" "):
        trial = word if not cur else cur + " " + word
        if text_width(trial, weight, px) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def msi_canvas(theme, w, h):
    t = THEMES[theme]
    img = Image.new("RGB", (w * MSI_S, h * MSI_S), rgb(t["background"]))
    return img, ImageDraw.Draw(img), t


def msi_text(img, xy, text, weight, px, fill, width=None, line=1.45):
    """Draw (wrapped) text at 1x coordinates; returns the y after the last line."""
    x, y = xy
    for ln in (wrap(text, weight, px * MSI_S, width * MSI_S) if width else [text]):
        draw_text(img, (x * MSI_S, y * MSI_S), ln, weight, px * MSI_S, fill)
        y += px * line
    return y


def msi_rail(img, d, t):
    d.rectangle((0, 0, MSI_RAIL * MSI_S, MSI_H * MSI_S), fill=rgb(t["muted"]))
    d.rectangle((MSI_RAIL * MSI_S, 0, (MSI_RAIL + 1) * MSI_S - 1, MSI_H * MSI_S), fill=rgb(t["border"]))
    mark = logo(56 * MSI_S)
    img.paste(mark, ((MSI_RAIL - 56) // 2 * MSI_S, 96 * MSI_S), mark)
    for text, weight, px, y, colour in (("Flint", "SemiBold", 18, 178, t["foreground"]), ("Your local AI workspace", "Regular", 11, 204, t["muted_fg"])):
        w = text_width(text, weight, px * MSI_S)
        draw_text(img, (MSI_RAIL / 2 * MSI_S - w / 2, y * MSI_S), text, weight, px * MSI_S, rgb(colour))


def msi_page(theme, name):
    spec = MSI_PAGES[name]
    img, d, t = msi_canvas(theme, MSI_W, MSI_H)
    msi_rail(img, d, t)
    y = msi_text(img, (MSI_X, 40), spec["title"], "SemiBold", 24, rgb(t["foreground"]), MSI_COL, 1.2)
    y = msi_text(img, (MSI_X, y + 6), spec["sub"], "Regular", 13, rgb(t["muted_fg"]), MSI_COL)
    if "label" in spec:
        msi_text(img, (MSI_X, 112), spec["label"], "Medium", 13, rgb(t["foreground"]))
        msi_text(img, (MSI_X, 190), spec["note"], "Regular", 12, rgb(t["muted_fg"]), MSI_COL)
    by = y + 26
    for para in spec.get("body", []):
        by = msi_text(img, (MSI_X, by), para, "Regular", 13, rgb(t["fg2"]), MSI_COL) + 8
    if "bullets" in spec:
        by += 10
        for b in spec["bullets"]:
            dot = Image.new("L", (8 * 8, 8 * 8), 0)
            ImageDraw.Draw(dot).ellipse((8, 8, 8 * 7 - 1, 8 * 7 - 1), fill=255)
            dot = dot.resize((8, 8), Image.LANCZOS)
            img.paste(Image.new("RGB", (8, 8), rgb(t["foreground"])), (MSI_X - 1, round(by + 3)), dot)
            msi_text(img, (MSI_X + 18, by), b, "Medium", 13, rgb(t["foreground"]))
            by += 24
    return img.resize((MSI_W * MSI_S, MSI_H * MSI_S), Image.LANCZOS)


def msi_small(theme, name):
    spec = MSI_SMALL[name]
    img, d, t = msi_canvas(theme, spec["w"], spec["h"])
    msi_text(img, (24, 20), spec["title"], "SemiBold", 15, rgb(t["foreground"]))
    if spec["body"]:
        msi_text(img, (24, 52), spec["body"], "Regular", 13, rgb(t["fg2"]), spec["w"] - 48)
    return img


def msi_button_w(label, small=False):
    """Visual width of an MSI button: the app width rounded up to a multiple of 4 px,
    so that every edge lands on a whole dialog unit (1 DU = 4/3 px)."""
    return (button_width(label, small) + 3) // 4 * 4


def msi_button_h(small=False):
    return 32 if small else 36


def msi_button(theme, variant, label):
    """The app Button at 1x, centred in a 4px margin of page colour.

    Windows Installer stretches a button bitmap to the WHOLE control, and draws its
    own 2px frame over the edge of it. So the control is the button plus 4px on
    every side, this art is exactly that size (a smaller one would be resampled and
    look blurry), and page-coloured strips over the margin hide the frame, see
    msi_dialogs()."""
    slug = slug_of(variant, label)
    small = slug in MSI_SMALL_SLUGS
    w, h = msi_button_w(label, small), msi_button_h(small)
    art = Image.new("RGB", (w + 8, h + 8), rgb(THEMES[theme]["background"]))
    art.paste(button(theme, variant, label, 100, width=w, small=small), (4, 4))
    return art


def slug_of(variant, label):
    return next(sl for v, sl, lb in MSI_BUTTONS if v == variant and lb == label)


# One place for every MSI dialog: geometry in px (multiples of 4, so DU are whole
# numbers) and the events each button publishes. Written to flint-ui-dialogs.wxi.
RIGHT = 468  # right edge of the footer button row, px


def du(px):
    assert px % 4 == 0, px
    return px * 3 // 4


def msi_dialogs():
    out = []
    T = MSI_THEME

    def cond(extra):
        return f'\n          <Condition Action="hide">{extra}</Condition>' if extra else ""

    def bitmap(cid, x, y, w, h, binary, extra=None):
        return (f'        <Control Id="{cid}" Type="Bitmap" X="{x}" Y="{y}" Width="{w}" Height="{h}" TabSkip="no" Text="{binary}">{cond(extra)}\n        </Control>')

    def push(cid, variant, slug, vx, vy, events, extra=None):
        """A bitmap button whose visual box is at (vx, vy) px, framed by page-coloured strips."""
        label = dict((sl, lb) for _, sl, lb in MSI_BUTTONS)[slug]
        small = slug in MSI_SMALL_SLUGS
        w = msi_button_w(label, small)
        cx, cy, cw, ch = vx - 4, vy - 4, w + 8, msi_button_h(small) + 8
        lines = [f'        <Control Id="{cid}" Type="PushButton" X="{du(cx)}" Y="{du(cy)}" Width="{du(cw)}" Height="{du(ch)}" Bitmap="yes" Text="Btn_{variant}_{slug}">{cond(extra)}']
        for ev, val, order, c in events:
            o = f' Order="{order}"' if order else ""
            what = f'Property="{ev[5:]}"' if ev.startswith("prop:") else f'Event="{ev}"'
            lines.append(f'          <Publish {what} Value="{val}"{o}>{c}</Publish>')
        lines.append('        </Control>')
        for tag, x, y, sw, sh in (("t", cx, cy, cw, 4), ("b", cx, cy + ch - 4, cw, 4), ("l", cx, cy, 4, ch), ("r", cx + cw - 4, cy, 4, ch)):
            lines.append(f'        <Control Id="{cid}_{tag}" Type="Bitmap" X="{du(x)}" Y="{du(y)}" Width="{du(sw)}" Height="{du(sh)}" TabSkip="no" Text="Solid">{cond(extra)}\n        </Control>')
        return "\n".join(lines)

    def dialog(did, w, h, page, buttons, native="", modeless=False, bg=None, keep_modeless=False):
        """buttons: (cid, variant, slug, vx, vy, events, extra_hide). bg: list of (id, binary, extra_hide) instead of one page."""
        mode = (' Modeless="yes"' if modeless else "") + (' KeepModeless="yes" TrackDiskSpace="yes"' if keep_modeless else "")
        out.append(f'      <Dialog Id="{did}" Width="{w}" Height="{h}" Title="Flint Setup" NoMinimize="yes"{mode}>')
        out.append('        <!-- Takes the initial focus so no button starts with a focus frame. Sits outside the dialog. -->')
        out.append(f'        <Control Id="FocusSink" Type="Edit" X="{w + 30}" Y="0" Width="1" Height="1" Property="FLINT_FOCUS_SINK" TabSkip="no" />')
        for cid, binary, extra in (bg or [("Bg", page, None)]):
            out.append(bitmap(cid, 0, 0, w, h, binary, extra))
        for cid, variant, slug, vx, vy, events, extra in buttons:
            out.append(push(cid, variant, slug, vx, vy, events, extra))
        if native:
            out.append(native)
        out.append('      </Dialog>\n')

    Y = 308
    NEXT = [("NewDialog", "FlintInstallDirDlg", "", "1")]
    cancel = [("SpawnDialog", "FlintCancelDlg", "", "1")]
    dialog("FlintWelcomeDlg", 370, 270, "Page_welcome", [
        ("Cancel", "outline", "cancel", RIGHT - 88 - 8 - 88, Y, cancel, None),
        ("Next", "primary", "continue", RIGHT - 88, Y, NEXT, None)])
    browse_w = msi_button_w("Browse", True)
    dialog("FlintInstallDirDlg", 370, 270, "Page_installdir", [
        ("Back", "outline", "back", RIGHT - 3 * 88 - 16, Y, [("NewDialog", "FlintWelcomeDlg", "", "1")], None),
        ("Cancel", "outline", "cancel", RIGHT - 88 - 8 - 88, Y, cancel, None),
        ("Install", "primary", "install", RIGHT - 88, Y, [("SetTargetPath", "[WIXUI_INSTALLDIR]", 1, "1"), ("EndDialog", "Return", 2, "1")], None),
        ("Browse", "outline", "browse", RIGHT - browse_w, 132, [("DoAction", "FlintBrowseFolder", "", "1")], None)],
        native=f'        <Control Id="FolderEdit" Type="PathEdit" X="137" Y="104" Width="{(RIGHT - browse_w - 8 - 182) * 3 // 4}" Height="15" Property="WIXUI_INSTALLDIR" Indirect="yes" />')
    for did, page in (("Flint_progress_Dlg", "Page_progress"), ("Flint_removing_Dlg", "Page_removing")):
        dialog(did, 370, 270, page, [("Cancel", "outline", "cancel", RIGHT - 88, Y, cancel, None)], modeless=True, native=
               '        <Control Id="ActionText" Type="Text" X="137" Y="112" Width="215" Height="10" Transparent="yes" NoPrefix="yes" Text="Starting">\n'
               '          <Subscribe Event="ActionText" Attribute="Text" />\n        </Control>\n'
               '        <Control Id="ProgressBar" Type="ProgressBar" X="137" Y="128" Width="215" Height="8" ProgressBlocks="no" Text="Progress">\n'
               '          <Subscribe Event="SetProgress" Attribute="Progress" />\n        </Control>\n'
               '        <Control Id="ActionData" Type="Text" X="137" Y="146" Width="215" Height="20" Transparent="yes" NoPrefix="yes" Text=" ">\n'
               '          <Subscribe Event="ActionData" Attribute="Text" />\n        </Control>')
    # Only "remove" is offered when Flint is already installed (ARPNOREPAIR and
    # ARPNOMODIFY are set), so Installed at exit means an uninstall just ran.
    installed = "Installed"
    launch_w = msi_button_w("Launch Flint")
    dialog("FlintExitDlg", 370, 270, None, [
        ("Close", "outline", "close", RIGHT - launch_w - 8 - 88, Y, [("EndDialog", "Return", "", "1")], installed),
        ("Launch", "primary", "launch", RIGHT - launch_w, Y, [("DoAction", "LaunchApplication", 1, "NOT Installed"), ("EndDialog", "Return", 2, "1")], installed),
        ("Finish", "primary", "close", RIGHT - 88, Y, [("EndDialog", "Return", "", "1")], "NOT Installed")],
        bg=[("BgDone", "Page_exit", installed), ("BgGone", "Page_removed", "NOT Installed")])
    for did, page in (("Flint_fatal_Dlg", "Page_fatal"), ("Flint_userexit_Dlg", "Page_userexit")):
        dialog(did, 370, 270, page, [("Close", "primary", "close", RIGHT - 88, Y, [("EndDialog", "Exit", "", "1")], None)])
    dialog("FlintRemoveDlg", 370, 270, "Page_remove", [
        ("Cancel", "outline", "cancel", RIGHT - 88 - 8 - 88, Y, cancel, None),
        ("Remove", "destructive", "uninstall", RIGHT - 88, Y, [("Remove", "All", 1, "1"), ("EndDialog", "Return", 2, "1")], None)])
    dialog("FlintCancelDlg", 264, 105, "Dlg_cancel", [
        ("Yes", "outline", "yes", 152, 84, [("EndDialog", "Exit", "", "1")], None),
        ("No", "primary", "no", 248, 84, [("EndDialog", "Return", "", "1")], None)])
    dialog("FilesInUse", 370, 270, "Page_filesinuse", [
        ("Exit", "outline", "exit", RIGHT - 3 * 88 - 16, Y, [("EndDialog", "Exit", "", "1")], None),
        ("Ignore", "outline", "ignore", RIGHT - 88 - 8 - 88, Y, [("EndDialog", "Ignore", "", "1")], None),
        ("Retry", "primary", "retry", RIGHT - 88, Y, [("EndDialog", "Retry", "", "1")], None)],
        keep_modeless=True,
        native='        <Control Id="List" Type="ListBox" X="137" Y="100" Width="215" Height="90" Property="FileInUseProcess" Sunken="yes" Sorted="yes" TabSkip="no" />')
    header = ['<?xml version="1.0" encoding="UTF-8"?>', '<!-- Generated by src-tauri/installer/generate.py (msi_dialogs). Do not edit. -->', '<Include>']
    (HERE / "wix" / "flint-ui-dialogs.wxi").write_text("\n".join(header + out + ['</Include>']) + "\n", encoding="utf-8", newline="\n")


def msi_assets():
    out = HERE / "wix" / "flint" / MSI_THEME
    out.mkdir(parents=True, exist_ok=True)
    lines = [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!-- Generated by src-tauri/installer/generate.py. Do not edit. -->",
        "<Include>",
    ]
    bs = "\\"

    def binary(name, file):
        lines.append(f'  <Binary Id="{name}" SourceFile="$(sys.SOURCEFILEDIR)flint{bs}{MSI_THEME}{bs}{file}" />')

    for name in MSI_PAGES:
        msi_page(MSI_THEME, name).save(out / f"page-{name}.png", optimize=True)
        binary(f"Page_{name}", f"page-{name}.png")
    for name in MSI_SMALL:
        msi_small(MSI_THEME, name).save(out / f"dlg-{name}.png", optimize=True)
        binary(f"Dlg_{name}", f"dlg-{name}.png")
    Image.new("RGB", (4, 4), rgb(THEMES[MSI_THEME]["background"])).save(out / "solid.bmp")
    binary("Solid", "solid.bmp")
    for variant, slug, label in MSI_BUTTONS:
        msi_button(MSI_THEME, variant, label).save(out / f"btn-{variant}-{slug}.bmp")
        binary(f"Btn_{variant}_{slug}", f"btn-{variant}-{slug}.bmp")
    lines.append("</Include>")
    msi_dialogs()
    (HERE / "wix" / "flint-ui-binaries.wxi").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


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
    wizard_assets()
    msi_assets()
    wix_assets()
    dmg_assets()
    print("installer assets written to", HERE)
