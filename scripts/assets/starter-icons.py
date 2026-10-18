"""Generate the starter-assistant icons (Emerald, Book and Quill, Compass,
Book) in web-app/public/images/assistants/.

Each icon is original pixel art drawn by hand as a 16x16 grid in the
style of the game's items (not traced from or derived from the game's
textures; the cut, proportions, facets and patterns are our own): one character per pixel, '.' is transparent, every other
character is a colour from that icon's palette. Light comes from the top
left, the darkest tone of each item is its one-pixel outline, and there is
no anti-aliasing inside the grid.

The grid is then treated like the older icons in this folder
(blaze/coal/quartz/redstone): blown up with hard pixels and resampled down
to 144x144, which leaves a soft one-pixel edge at 144 px.

Run: python scripts/assets/starter-icons.py   (needs Pillow)
"""
import os

from PIL import Image

GRID = 16
SIZE = 144
BIG = GRID * 72  # hard-pixel upscale before the soft resample
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'web-app', 'public', 'images', 'assistants')

ICONS = {}

# --- Emerald: step-cut (rectangular, clipped corners) gem with a flat table --
ICONS['emerald'] = ({
    'O': '#073d18',  # outline
    's': '#0b5e25',  # deep shadow, bottom step
    'd': '#0a7a2e',  # dark step, right/bottom
    'm': '#14a043',  # table rim
    'l': '#2ecf63',  # table
    'h': '#a8ffc8',  # lit step, top/left
    'w': '#e6fff0',  # glint
}, [
    '................',
    '.....OOOOOO.....',
    '....OwwhhllO....',
    '...OwhhhhllmO...',
    '..OhhhhhllllmO..',
    '..OhhhhllllmdO..',
    '..OmmmmmmmmddO..',
    '..OhlllllmmdsO..',
    '..OwhllllmmdsO..',
    '..OhlllllmmdsO..',
    '..OhllllmmmdsO..',
    '...OhllmmmdsO...',
    '....OlmmmdsO....',
    '.....OmmdsO.....',
    '......OOOO......',
    '................',
])

# --- Compass: wide oval case seen from above, lit rim top-left, diagonal needle
ICONS['compass'] = ({
    'O': '#1b1d24',  # outline
    'd': '#3a3f4b',  # rim, darkest side
    'R': '#4f5563',  # rim, shaded
    'r': '#7d8494',  # rim, mid
    'L': '#b4bbc8',  # rim, lit
    'W': '#eef1f6',  # rim, highlight
    'F': '#2b2f38',  # dial face
    'T': '#646b7a',  # dial ticks
    'N': '#e0392c',  # needle, north half
    'n': '#952118',  # needle, north half shaded
    'S': '#d6dbe3',  # needle, south half
    'P': '#a6adb9',  # pivot
    's': '#8f97a4',  # needle, south half shaded
}, [
    '................',
    '................',
    '................',
    '....OOOOOOOO....',
    '..OOWWWLLLrrOO..',
    '.OWWLrRRRRRRrRO.',
    '.OWLRFFFTFNnRrO.',
    'OWLRFFFFFNnFFRrO',
    'OLLRTFFFPPFFFTRO',
    'OLrRFFFSsFFFFRRO',
    'OLrRFFSsFFFFFRRO',
    '.OrRFFFFTFFFRRO.',
    '.OrrRRRRRRRRRdO.',
    '..OOrrRRRRddOO..',
    '....OOOOOOOO....',
    '................',
])

# --- Book: upright cover leaning right, spine left, page block right/bottom --
BOOK = {
    'O': '#2a140c',  # outline
    'B': '#4a2414',  # spine
    'c': '#6b3720',  # cover, shaded / tooled bands
    'C': '#8a4a2a',  # cover
    'H': '#b06a3e',  # cover, lit edge
    'g': '#d4a64a',  # brass corner
    'P': '#efe6d2',  # pages
    'p': '#c2b497',  # page edges
}
ICONS['book'] = (BOOK, [
    '................',
    '................',
    '.....OOOOOOOOO..',
    '....OHHHHHHHHgO.',
    '...OHcccccccCPO.',
    '...OHcCCCCCcCPO.',
    '..OHcCCCCCcCPPO.',
    '..OHcCCCCCcCPO..',
    '..OCcccccccCPO..',
    '.OCCCCCCCCCPO...',
    '.OCCCCCCCCcPO...',
    'OPPPPPPPPPPpO...',
    'OpPpPpPpPpPO....',
    'OccccccccccO....',
    '.OOOOOOOOOO.....',
    '................',
])

# --- Book and Quill: the book in a darker binding, quill laid across it -----
ICONS['book-and-quill'] = (dict(BOOK, **{
    'B': '#3a1a12',  # spine
    'c': '#4f2418',  # cover, shaded
    'C': '#663222',  # cover
    'H': '#86493a',  # cover, lit edge
    'V': '#f4f6f8',  # feather vane
    'v': '#c4cad3',  # feather vane, shaded
    'q': '#a9b0bb',  # quill shaft
    'k': '#14161c',  # inked nib
}), [
    '.............O..',
    '...........OOVO.',
    '.....OOOOOOVVqvO',
    '....OHHHHHVVqvO.',
    '...OHccccVVqvvO.',
    '...OHcCCCVqvvPO.',
    '..OHcCCCVVqvPPO.',
    '..OHcCCVVqvvPO..',
    '..OCccVVqvvCPO..',
    '.OCCVVVqvvCPO...',
    '.OCCVqqvvCcPO...',
    'OPPPkPvvPPPpO...',
    'OpPkPpPpPpPO....',
    'OccccccccccO....',
    '.OOOOOOOOOO.....',
    '................',
])


def hexc(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def render(palette, rows):
    assert len(rows) == GRID and all(len(r) == GRID for r in rows), rows
    img = Image.new('RGBA', (GRID, GRID), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != '.':
                img.putpixel((x, y), hexc(palette[ch]) + (255,))
    # Same treatment as the older icons: hard pixels, then a soft resample.
    big = img.resize((BIG, BIG), Image.NEAREST)
    soft = big.resize((SIZE, SIZE), Image.LANCZOS)
    # Fewer colours keeps each PNG near 3 KB without visible banding.
    return soft.quantize(64, method=Image.FASTOCTREE)


def main():
    for name, (palette, rows) in ICONS.items():
        path = os.path.join(OUT, name + '.png')
        render(palette, rows).save(path, optimize=True)
        print(path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
