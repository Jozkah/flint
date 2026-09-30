"""Subset Flint's bundled Inter (web-app/public/fonts/inter) to Latin WOFF2 for the website.
Run once: python scripts/make-fonts.py   (needs fonttools + brotli). Output is committed."""
import pathlib
from fontTools import subset
root = pathlib.Path(__file__).resolve().parents[2]
src = root / 'web-app/public/fonts/inter'
out = pathlib.Path(__file__).resolve().parents[1] / 'public/fonts'
out.mkdir(parents=True, exist_ok=True)
unicodes = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2192, 0x00B7, 0x2212, 0x2318]
for name, weight in [('Regular', 400), ('Medium', 500), ('SemiBold', 600), ('Bold', 700)]:
    opts = subset.Options(); opts.flavor = 'woff2'; opts.layout_features = ['kern', 'liga', 'calt', 'ccmp', 'tnum', 'cv11', 'ss03']; opts.notdef_outline = True
    font = subset.load_font(str(src / f'Inter_18pt-{name}.ttf'), opts)
    s = subset.Subsetter(opts); s.populate(unicodes=unicodes); s.subset(font)
    subset.save_font(font, str(out / f'inter-{weight}.woff2'), opts)
    print(weight, (out / f'inter-{weight}.woff2').stat().st_size)
