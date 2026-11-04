#!/usr/bin/env python3
"""Brand pixel art for SQFT: a surveyed lot with a house on plat-map paper.

    python3 tools/pixelart.py

Writes public/icon.png (512), public/apple-touch-icon.png (180),
public/logo-small.png (64) and public/logo.png (1200x630 OG card).
Everything is drawn on a small grid and scaled with nearest-neighbour so
the pixels stay hard. No external assets.
"""
from PIL import Image, ImageDraw
import os, random

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public')
random.seed(11)

P = {
    'paper': (239, 230, 210), 'paper2': (251, 247, 238), 'grid': (220, 207, 174), 'contour': (224, 212, 182),
    'ink': (28, 42, 30), 'ink2': (74, 90, 76),
    'grass': (79, 138, 63), 'grass_l': (103, 163, 82), 'grass_d': (47, 106, 43),
    'road': (216, 203, 166), 'road_d': (201, 187, 149), 'dash': (246, 239, 223),
    'orange': (228, 87, 27), 'orange_d': (184, 65, 15), 'cream': (251, 247, 238), 'cream_d': (231, 223, 203),
    'roof': (201, 74, 43), 'roof_d': (157, 54, 28), 'glass': (159, 209, 232), 'door': (42, 58, 44),
    'hat': (242, 193, 78), 'water': (143, 191, 216), 'water_d': (111, 168, 199), 'trunk': (138, 90, 43),
}

def put(g, x, y, c): g[(x, y)] = P[c]

def lot(g, x0, y0, w, h, houses=1, stakes=0, label=None):
    """A grass lot with a dashed ink boundary, a few houses and stakes."""
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            c = 'grass' if (x * 7 + y * 13) % 11 else 'grass_l'
            if (x + y) % 17 == 0: c = 'grass_d'
            if x in (x0, x0 + w - 1) or y in (y0, y0 + h - 1): c = 'ink' if ((x + y) // 2) % 2 else 'grass_d'
            put(g, x, y, c)
    # houses on a jittered grid inside
    spots = [(x0 + 3 + i * 9, y0 + 10 + j * 9) for j in range((h - 12) // 9) for i in range((w - 6) // 9)]
    random.shuffle(spots)
    for (hx, hy) in spots[:houses]: house(g, hx, hy)
    for k in range(stakes): stake(g, x0 + w - 5, y0 + 4 + k * 5)
    if label: sign(g, x0 + 2, y0 + 2, label)

def house(g, x, y, roof='roof'):
    rows = ['..RRR..', '.RRRRR.', 'RRRRRRR', 'KWWWWWK', 'KWLWDWK', 'KWWWDWK', 'KKKKKKK']
    col = {'R': roof, 'K': 'ink', 'W': 'cream', 'L': 'glass', 'D': 'door'}
    for j, row in enumerate(rows):
        for i, v in enumerate(row):
            if v != '.': put(g, x + i, y + j, col[v])

def big_house(g, x, y):
    """The hero house for the icon: 15 wide, 13 tall."""
    rows = [
        '......RRR......',
        '....RRRRRRR....',
        '..RRRRRRRRRRR..',
        'RRRRRRRRRRRRRRR',
        'KWWWWWWWWWWWWWK',
        'KWLLWWWWWWWLLWK',
        'KWLLWWWDDWWWLLK',
        'KWWWWWWDDWWWWWK',
        'KWWWWWWDDWWWWWK',
        'KKKKKKKKKKKKKKK',
    ]
    col = {'R': 'roof', 'K': 'ink', 'W': 'cream', 'L': 'glass', 'D': 'door'}
    for j, row in enumerate(rows):
        for i, v in enumerate(row):
            if v != '.': put(g, x + i, y + j, col[v])
    # roof shading
    for i in range(3, 12):
        if i % 2: put(g, x + i, y + 3, 'roof_d')

def stake(g, x, y):
    for j in range(4): put(g, x, y + j, 'ink')
    for j in range(2):
        put(g, x + 1, y + j, 'orange'); put(g, x + 2, y + j, 'orange')

def tree(g, x, y):
    rows = ['.GG.', 'GGGg', '.gg.', '..T.']
    col = {'G': 'grass', 'g': 'grass_d', 'T': 'trunk'}
    for j, row in enumerate(rows):
        for i, v in enumerate(row):
            if v != '.': put(g, x + i, y + j, col[v])

FONT = {  # 5x7
    'A': ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
    'B': ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.'],
    'C': ['.XXXX', 'X....', 'X....', 'X....', 'X....', 'X....', '.XXXX'],
    'E': ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
    'F': ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
    'M': ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X', 'X...X', 'X...X'],
    'O': ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
    'Q': ['.XXX.', 'X...X', 'X...X', 'X...X', 'X.X.X', 'X..X.', '.XX.X'],
    'R': ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
    'S': ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
    'T': ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
    'U': ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}
def text(g, s, ox, oy, color='ink'):
    for ch in s:
        for j, row in enumerate(FONT[ch]):
            for i, v in enumerate(row):
                if v == 'X': put(g, ox + i, oy + j, color)
        ox += 6

SMALL = {  # 3x5
    'U': ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'], 'S': ['XXX', 'X..', 'XXX', '..X', 'XXX'], 'A': ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
    'N': ['X.X', 'XXX', 'XXX', 'XXX', 'X.X'], 'Y': ['X.X', 'X.X', '.X.', '.X.', '.X.'], 'C': ['XXX', 'X..', 'X..', 'X..', 'XXX'],
    'H': ['X.X', 'X.X', 'XXX', 'X.X', 'X.X'], 'I': ['XXX', '.X.', '.X.', '.X.', 'XXX'], 'L': ['X..', 'X..', 'X..', 'X..', 'XXX'],
    'M': ['X.X', 'XXX', 'XXX', 'X.X', 'X.X'], 'T': ['XXX', '.X.', '.X.', '.X.', '.X.'], 'X': ['X.X', 'X.X', '.X.', 'X.X', 'X.X'],
    'D': ['XX.', 'X.X', 'X.X', 'X.X', 'XX.'], 'F': ['XXX', 'X..', 'XX.', 'X..', 'X..'],
}
def sign(g, x, y, label):
    for j in range(8):
        for i in range(16):
            put(g, x + i, y + j, 'ink' if i in (0, 15) or j in (0, 7) else 'paper2')
    put(g, x + 7, y + 8, 'ink'); put(g, x + 8, y + 8, 'ink'); put(g, x + 7, y + 9, 'ink'); put(g, x + 8, y + 9, 'ink')
    cx = x + 2
    for ch in label[:3]:
        for j, row in enumerate(SMALL[ch]):
            for i, v in enumerate(row):
                if v == 'X': put(g, cx + i, y + 2 + j, 'ink')
        cx += 4

def render(grid, w, h, scale, bg='paper', dots=True):
    img = Image.new('RGB', (w, h), P[bg])
    d = ImageDraw.Draw(img)
    if dots:
        for y in range(0, h, 8):
            for x in range(0, w, 8):
                d.point((x, y), P['grid'])
    for (x, y), c in grid.items():
        if 0 <= x < w and 0 <= y < h: d.point((x, y), c)
    return img.resize((w * scale, h * scale), Image.NEAREST)

# ---------- icon: one lot, one big house, a stake, on paper ----------
g = {}
# contour lines
for y in range(48):
    for x in range(48):
        if (x - 10) ** 2 // 9 + (y - 40) ** 2 // 4 in (60, 61) or (x - 44) ** 2 // 6 + (y + 2) ** 2 // 7 in (70, 71): put(g, x, y, 'contour')
for y in range(6, 42):
    for x in range(6, 42):
        c = 'grass' if (x * 7 + y * 13) % 11 else 'grass_l'
        if (x + y) % 17 == 0: c = 'grass_d'
        if x in (6, 7, 40, 41) or y in (6, 7, 40, 41): c = 'ink' if ((x + y) // 2) % 2 else 'grass_d'
        put(g, x, y, c)
big_house(g, 16, 17)
stake(g, 34, 10); stake(g, 10, 33)
tree(g, 10, 10); tree(g, 32, 33)
for name, size in (('icon.png', 512), ('apple-touch-icon.png', 180), ('logo-small.png', 64)):
    render(g, 48, 48, 1).resize((size, size), Image.NEAREST).save(os.path.join(ROOT, name))

# ---------- OG card 1200x630 = 200x105 grid at scale 6 ----------
W, H = 200, 105
g = {}
# river down the right
for y in range(H):
    rx = int(178 - y * 0.35 + (3 if (y // 9) % 2 else 0))
    for x in range(rx - 3, rx + 4):
        put(g, x, y, 'water_d' if abs(x - rx) < 3 else 'road_d')
# contours
for y in range(H):
    for x in range(W):
        if (x - 30) ** 2 // 30 + (y - 100) ** 2 // 6 in (90, 91): put(g, x, y, 'contour')
# a road along the bottom and the lots above it
for y in range(74, 79):
    for x in range(0, W):
        put(g, x, y, 'road_d' if (x + y) % 9 == 0 else 'road')
for x in range(0, W, 3): put(g, x, 76, 'dash')
labels = ['USA', 'NYC', 'CHI', 'LA', 'MIA', 'ATX', 'DC', 'SF']
counts = [5, 3, 2, 4, 3, 2, 1, 2]
for i, (lb, n) in enumerate(zip(labels, counts)):
    x0 = 8 + i * 21
    if x0 + 19 > 172: break
    lot(g, x0, 44, 19, 30, houses=min(n, 2), stakes=1 if i % 3 == 0 else 0, label=lb)
# the big lot + house on the left, headline on the right
lot(g, 10, 8, 40, 32, houses=0, stakes=0)
big_house(g, 22, 18)
stake(g, 42, 12); tree(g, 13, 11)
text(g, 'SQFT', 60, 10, 'ink')
text(g, 'FEES BECOME', 60, 22, 'orange')
text(g, 'SQUARE FEET', 60, 32, 'orange')
for x in range(60, 126): put(g, x, 41, 'ink' if x % 2 == 0 else 'ink2')
# a few trees on the paper
for (tx, ty) in ((150, 14), (160, 30), (4, 90), (120, 92), (60, 94), (186, 60), (140, 8)):
    tree(g, tx, ty)
render(g, W, H, 6).save(os.path.join(ROOT, 'logo.png'))
print('wrote icon.png apple-touch-icon.png logo-small.png logo.png')
