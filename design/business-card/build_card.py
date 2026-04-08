# -*- coding: utf-8 -*-
"""
Lexoria 名刺 PDF — fpdf2 固定レイアウト

- 出力は表面・裏面それぞれ 1 ページの PDF ファイル（計 2 ファイル）。1 ファイル 1 ページ＝1 面。
- 91×55mm 仕上げ / 97×61mm 塗り足し / トンボ
- LP（public/index.html）ロゴと同一英字: Cormorant Garamond（Lexoria は 600 相当）
- Cormorant を取得できない場合は Lexoria / Founder を Inter にフォールバック
- 日本語: Noto Serif JP。メール: Inter Regular
"""
from __future__ import annotations

import urllib.request
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Literal

from fpdf import FPDF
from fpdf.enums import XPos, YPos

ROOT = Path(__file__).resolve().parent
FONTS = ROOT / "fonts"

# --- Noto Serif JP（gstatic 静的 TTF）---
SERIF_REG = FONTS / "NotoSerifJP-Google-Regular.ttf"
SERIF_BOLD = FONTS / "NotoSerifJP-Google-Bold.ttf"
SERIF_REG_URL = "https://fonts.gstatic.com/s/notoserifjp/v33/xn71YHs72GKoTvER4Gn3b5eMRtWGkp6o7MjQ2bwxOubA.ttf"
SERIF_BOLD_URL = "https://fonts.gstatic.com/s/notoserifjp/v33/xn71YHs72GKoTvER4Gn3b5eMRtWGkp6o7MjQ2bzWPebA.ttf"

# --- Cormorant Garamond（LP .logo / ブランド英字・fonts.googleapis.com と同一系）---
CORM_REG = FONTS / "CormorantGaramond-Google-Regular.ttf"
CORM_600 = FONTS / "CormorantGaramond-Google-SemiBold.ttf"
CORM_REG_URL = "https://fonts.gstatic.com/s/cormorantgaramond/v21/co3umX5slCNuHLi8bLeY9MK7whWMhyjypVO7abI26QOD_v86GnM.ttf"
CORM_600_URL = "https://fonts.gstatic.com/s/cormorantgaramond/v21/co3umX5slCNuHLi8bLeY9MK7whWMhyjypVO7abI26QOD_iE9GnM.ttf"

# --- Inter 400 / 500（メール・Cormorant 失敗時の代替）---
INTER_REG = FONTS / "Inter-Google-Regular.ttf"
INTER_MED = FONTS / "Inter-Google-Medium.ttf"
INTER_REG_URL = "https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf"
INTER_MED_URL = "https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuI6fMZg.ttf"

QR_PNG = ROOT / "qr-code.png"
OUT_PDF_FRONT = ROOT / "Lexoria-BusinessCard-Front.pdf"
OUT_PDF_BACK = ROOT / "Lexoria-BusinessCard-Back.pdf"

PAGE_W = 97.0
PAGE_H = 61.0
BLEED = 3.0
TRIM_L = BLEED
TRIM_T = BLEED
TRIM_R = BLEED + 91.0
TRIM_B = BLEED + 55.0

SAFE_INSET = 5.0
SAFE_L = TRIM_L + SAFE_INSET
SAFE_R = TRIM_R - SAFE_INSET
SAFE_T = TRIM_T + SAFE_INSET
SAFE_B = TRIM_B - SAFE_INSET
SAFE_W = SAFE_R - SAFE_L

CROP = (60, 60, 60)

BEIGE = (245, 241, 232)
PANEL = (228, 221, 210)
# 右側のみ「薄い紺」寄りトーン（実質ベージュへ約 8% だけ紺を足した不透明度風ブレンド。PDF 透明度は使わず印刷互換）
NAVY_WHISPER = (236, 234, 242)
NAVY_DEEP = (42, 52, 72)

GOLD_LINE = (176, 145, 90)
INK = (26, 26, 46)
TEXT_BODY = (48, 52, 64)
TEXT_MUTED = (98, 94, 86)
# サイト URL（表面・https 付き表記）
TEXT_URL_SUBTLE = (138, 134, 126)

CATCH_ONE_LINE = "初回相談メモを10秒で整理"
EMAIL = "support@lexoriaai.com"
EMAIL_WITH_LABEL = f"E-mail: {EMAIL}"
SITE_URL_DISPLAY = "https://lexoria-main.vercel.app"
BACK_HEAD = "この相談文で試せます"
BACK_SAMPLE_CAPTION = "— 相談例 —"
BACK_LINE_1 = "夫と離婚したいが、"
BACK_LINE_2 = "子どもの親権でもめている。"
BACK_LINE_3 = "財産分与も不安。"

FontFamily = Literal[
    "NotoSerifJP",
    "Inter",
    "InterMed",
    "Cormorant",
    "CormorantSb",
]


@dataclass(frozen=True)
class TextRow:
    y_mm: float
    h_mm: float
    family: FontFamily
    style: Literal["", "B"]
    size_pt: float
    color: tuple[int, int, int]
    text: str
    char_spacing_mm: float = 0.0


def _fetch(url: str, dest: Path) -> None:
    FONTS.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())


def ensure_fonts() -> bool:
    """必須フォントを取得。Cormorant は失敗しても True（Inter に切替）。"""
    required = [
        (SERIF_REG, SERIF_REG_URL),
        (SERIF_BOLD, SERIF_BOLD_URL),
        (INTER_REG, INTER_REG_URL),
        (INTER_MED, INTER_MED_URL),
    ]
    for path, url in required:
        if not path.exists():
            _fetch(url, path)

    for path, url in [(CORM_REG, CORM_REG_URL), (CORM_600, CORM_600_URL)]:
        if path.exists():
            continue
        try:
            _fetch(url, path)
        except OSError:
            pass
    return cormorant_available()


def cormorant_available() -> bool:
    return CORM_REG.exists() and CORM_600.exists()


def brand_wordmark_fonts() -> tuple[FontFamily, FontFamily]:
    """(Founder / 補助英字, Lexoria)。Cormorant 優先。"""
    if cormorant_available():
        return "Cormorant", "CormorantSb"
    return "Inter", "InterMed"


# 表面は左寄せ。右側は装飾専用エリア。
FRONT_COL_X = SAFE_L + 1.6
FRONT_COL_W = 52.0
NAME_ROMAJI_GAP_MM = 2.8
ROMAJI_COLOR = (51, 51, 51)
NAME_UNDERLINE_COLOR = (68, 68, 68)
NAME_UNDERLINE_WIDTH_MM = 0.42
NAME_UNDERLINE_PAD_MM = 2.2
NAME_ROMAJI_PT = 12.2

# 表面順: 1)Lexoria 2)Founder 3)岩根亘杜(+ Iwane Haruto) 4)ツール説明 5)キャッチ 6)メール 7)サイト URL
# Founder の縦位置は Lexoria 下端と名前ブロック上端の中点にセンタリング（y は h の半分を差し引く）
_LEX_Y_OFF = 2.25
_LEX_H = 7.5
_LEX_BOTTOM_OFF = _LEX_Y_OFF + _LEX_H
_NAME_TOP_OFF = 15.1
_FOUNDER_H = 3.8
_FOUNDER_Y_OFF = (_LEX_BOTTOM_OFF + _NAME_TOP_OFF) / 2.0 - _FOUNDER_H / 2.0

FRONT_LEX = TextRow(
    SAFE_T + _LEX_Y_OFF,
    _LEX_H,
    "CormorantSb",
    "",
    16.0,
    INK,
    "Lexoria",
    0.08,
)
FRONT_FOUNDER = TextRow(
    SAFE_T + _FOUNDER_Y_OFF,
    _FOUNDER_H,
    "Cormorant",
    "",
    8.0,
    TEXT_MUTED,
    "Founder",
    0.07,
)
FRONT_NAME = TextRow(
    SAFE_T + 15.1,
    9.8,
    "NotoSerifJP",
    "B",
    16.8,
    INK,
    "岩根亘杜",
    0.08,
)
FRONT_SUB1 = TextRow(
    SAFE_T + 27.2,
    4.6,
    "NotoSerifJP",
    "",
    7.2,
    TEXT_BODY,
    "弁護士向け初回相談整理ツール",
    0.03,
)
FRONT_SUB2 = TextRow(
    SAFE_T + 32.4,
    4.6,
    "NotoSerifJP",
    "",
    6.4,
    TEXT_BODY,
    CATCH_ONE_LINE,
    0.03,
)
# メールと URL: 下揃えで SAFE_B 内に収める（行間は狭めで関連性）
FRONT_EMAIL = TextRow(
    SAFE_B - 6.15,
    3.5,
    "Inter",
    "",
    5.7,
    TEXT_MUTED,
    EMAIL_WITH_LABEL,
    0.03,
)
FRONT_URL = TextRow(
    SAFE_B - 2.2,
    2.2,
    "Inter",
    "",
    5.2,
    TEXT_URL_SUBTLE,
    SITE_URL_DISPLAY,
    0.02,
)

LEXORIA_LINE_Y = SAFE_T + _LEX_BOTTOM_OFF - 0.15
LEXORIA_LINE_W = 15.0

BACK_HEAD_ROW = TextRow(
    SAFE_T + 0.25,
    4.4,
    "NotoSerifJP",
    "B",
    8.9,
    INK,
    BACK_HEAD,
    0.06,
)

QR_MM = 21.0
QR_X = TRIM_L + (91.0 - QR_MM) / 2.0
QR_Y = SAFE_T + 4.85

# QR 下 →「相談例」キャプション（やや小）→ 相談本文（行間やや広め）。y は page_back で整合。
BACK_QR_TO_CAPTION_MM = 3.5
BACK_CAPTION_H_MM = 2.85
BACK_CAPTION_FS = 6.0
BACK_CAPTION_TO_BODY_MM = 1.0
BACK_BODY_LH = 3.92
BACK_BODY_FS = 7.45

BACK_BODY_LINES_SRC: tuple[str, ...] = (
    BACK_LINE_1,
    BACK_LINE_2,
    BACK_LINE_3,
)


def draw_background(pdf: FPDF) -> None:
    pdf.set_fill_color(*PANEL)
    pdf.rect(0.0, 0.0, PAGE_W, PAGE_H, style="F")

    # 右側にだけ極薄い紺みを乗せた面（全面禁止・斜め下地と重ねる）
    r0, g0, b0 = BEIGE
    r1, g1, b1 = NAVY_DEEP
    blend = 0.08
    nr = int(r0 * (1 - blend) + r1 * blend)
    ng = int(g0 * (1 - blend) + g1 * blend)
    nb = int(b0 * (1 - blend) + b1 * blend)
    pdf.set_fill_color(nr, ng, nb)
    pdf.polygon(
        [
            (PAGE_W * 0.5, 0.0),
            (PAGE_W, 0.0),
            (PAGE_W, PAGE_H),
            (PAGE_W * 0.38, PAGE_H),
            (PAGE_W * 0.44, PAGE_H * 0.55),
        ],
        style="F",
    )

    pdf.set_fill_color(*NAVY_WHISPER)
    pdf.polygon(
        [
            (PAGE_W * 0.62, 0.0),
            (PAGE_W, 0.0),
            (PAGE_W, PAGE_H * 0.65),
            (PAGE_W * 0.78, PAGE_H),
        ],
        style="F",
    )

    pdf.set_fill_color(*BEIGE)
    pdf.polygon(
        [
            (0.0, 0.0),
            (PAGE_W * 0.5, 0.0),
            (PAGE_W, PAGE_H * 0.46),
            (PAGE_W, PAGE_H),
            (PAGE_W * 0.06, PAGE_H),
            (0.0, PAGE_H * 0.92),
        ],
        style="F",
    )


def draw_right_decor(pdf: FPDF) -> None:
    """右側の控えめな装飾レイヤー。"""
    x0 = SAFE_R - 23.0
    pdf.set_fill_color(230, 226, 219)
    pdf.polygon(
        [
            (x0, TRIM_T),
            (TRIM_R, TRIM_T),
            (TRIM_R, TRIM_B),
            (x0 + 7.0, TRIM_B),
            (x0 - 1.5, TRIM_T + 20.0),
        ],
        style="F",
    )
    pdf.set_fill_color(216, 220, 231)
    pdf.polygon(
        [
            (x0 + 8.0, TRIM_T + 4.0),
            (TRIM_R, TRIM_T + 4.0),
            (TRIM_R, TRIM_B - 10.0),
            (x0 + 14.0, TRIM_B),
            (x0 + 5.0, TRIM_T + 18.0),
        ],
        style="F",
    )


def draw_crop_marks(pdf: FPDF) -> None:
    L, T, R, B = TRIM_L, TRIM_T, TRIM_R, TRIM_B
    m = 3.0
    pdf.set_line_width(0.15)
    pdf.set_draw_color(*CROP)
    pdf.line(L - m, T, L, T)
    pdf.line(L, T - m, L, T)
    pdf.line(R, T, R + m, T)
    pdf.line(R, T - m, R, T)
    pdf.line(L - m, B, L, B)
    pdf.line(L, B, L, B + m)
    pdf.line(R, B, R + m, B)
    pdf.line(R, B, R, B + m)


def register_fonts(pdf: FPDF) -> None:
    pdf.add_font("NotoSerifJP", "", str(SERIF_REG))
    pdf.add_font("NotoSerifJP", "B", str(SERIF_BOLD))
    pdf.add_font("Inter", "", str(INTER_REG))
    pdf.add_font("InterMed", "", str(INTER_MED))
    if cormorant_available():
        pdf.add_font("Cormorant", "", str(CORM_REG))
        pdf.add_font("CormorantSb", "", str(CORM_600))


def draw_row_centered(pdf: FPDF, row: TextRow) -> None:
    pdf.set_char_spacing(row.char_spacing_mm)
    pdf.set_text_color(*row.color)
    pdf.set_font(row.family, row.style, row.size_pt)
    pdf.set_xy(SAFE_L, row.y_mm)
    pdf.cell(
        SAFE_W,
        row.h_mm,
        row.text,
        align="C",
        new_x=XPos.LEFT,
        new_y=YPos.TOP,
    )
    pdf.set_char_spacing(0.0)


def draw_row_left(pdf: FPDF, row: TextRow, x: float = FRONT_COL_X, w: float = FRONT_COL_W) -> None:
    pdf.set_char_spacing(row.char_spacing_mm)
    pdf.set_text_color(*row.color)
    pdf.set_font(row.family, row.style, row.size_pt)
    pdf.set_xy(x, row.y_mm)
    pdf.cell(
        w,
        row.h_mm,
        row.text,
        align="L",
        new_x=XPos.LEFT,
        new_y=YPos.TOP,
    )
    pdf.set_char_spacing(0.0)


def page_front(pdf: FPDF) -> None:
    draw_background(pdf)
    draw_right_decor(pdf)
    draw_crop_marks(pdf)
    fam_tag, fam_lex = brand_wordmark_fonts()
    draw_row_left(pdf, replace(FRONT_LEX, family=fam_lex))
    draw_row_left(pdf, replace(FRONT_FOUNDER, family=fam_tag))

    # 日本語名 + ローマ字（下線の上に載せるレイヤー：先に線、後から文字）
    ny = FRONT_NAME.y_mm
    nh = FRONT_NAME.h_mm
    pdf.set_font("NotoSerifJP", "B", FRONT_NAME.size_pt)
    pdf.set_char_spacing(FRONT_NAME.char_spacing_mm)
    name_w = pdf.get_string_width(FRONT_NAME.text)
    line_x0 = FRONT_COL_X - 0.5
    line_x1 = FRONT_COL_X + name_w + NAME_UNDERLINE_PAD_MM
    line_y = ny + nh - 0.5

    pdf.set_draw_color(*NAME_UNDERLINE_COLOR)
    pdf.set_line_width(NAME_UNDERLINE_WIDTH_MM)
    pdf.line(line_x0, line_y, line_x1, line_y)

    pdf.set_text_color(*INK)
    pdf.set_font("NotoSerifJP", "B", FRONT_NAME.size_pt)
    pdf.set_xy(FRONT_COL_X, ny)
    pdf.cell(
        name_w + 0.8,
        nh,
        FRONT_NAME.text,
        align="L",
        new_x=XPos.LEFT,
        new_y=YPos.TOP,
    )
    pdf.set_char_spacing(0.0)

    pdf.set_font(fam_tag, "", NAME_ROMAJI_PT)
    pdf.set_text_color(*ROMAJI_COLOR)
    pdf.set_char_spacing(0.04)
    rx = FRONT_COL_X + name_w + NAME_ROMAJI_GAP_MM
    romaji_y = ny + 1.2
    pdf.set_xy(rx, romaji_y)
    pdf.cell(
        max(12.0, FRONT_COL_X + FRONT_COL_W - rx),
        nh,
        "Iwane Haruto",
        align="L",
        new_x=XPos.LEFT,
        new_y=YPos.TOP,
    )
    pdf.set_char_spacing(0.0)

    draw_row_left(pdf, FRONT_SUB1)
    draw_row_left(pdf, FRONT_SUB2)

    pdf.set_draw_color(*GOLD_LINE)
    pdf.set_line_width(0.15)
    pdf.line(
        FRONT_COL_X,
        LEXORIA_LINE_Y,
        FRONT_COL_X + LEXORIA_LINE_W,
        LEXORIA_LINE_Y,
    )

    draw_row_left(pdf, FRONT_EMAIL)
    draw_row_left(pdf, FRONT_URL, w=SAFE_R - FRONT_COL_X)


def page_back(pdf: FPDF) -> None:
    draw_background(pdf)
    draw_crop_marks(pdf)

    draw_row_centered(pdf, BACK_HEAD_ROW)

    if QR_PNG.exists():
        pdf.image(str(QR_PNG), x=QR_X, y=QR_Y, w=QR_MM, h=QR_MM)

    cap_y = QR_Y + QR_MM + BACK_QR_TO_CAPTION_MM
    draw_row_centered(
        pdf,
        TextRow(
            cap_y,
            BACK_CAPTION_H_MM,
            "NotoSerifJP",
            "",
            BACK_CAPTION_FS,
            TEXT_MUTED,
            BACK_SAMPLE_CAPTION,
            0.14,
        ),
    )

    body_y0 = cap_y + BACK_CAPTION_H_MM + BACK_CAPTION_TO_BODY_MM
    pdf.set_text_color(*TEXT_BODY)
    pdf.set_char_spacing(0.06)
    pdf.set_font("NotoSerifJP", "", BACK_BODY_FS)
    y = body_y0
    for line in BACK_BODY_LINES_SRC:
        pdf.set_xy(SAFE_L, y)
        pdf.cell(
            SAFE_W,
            BACK_BODY_LH,
            line,
            align="C",
            new_x=XPos.LEFT,
            new_y=YPos.TOP,
        )
        y += BACK_BODY_LH
    pdf.set_char_spacing(0.0)

    last_y = body_y0 + len(BACK_BODY_LINES_SRC) * BACK_BODY_LH
    if last_y > SAFE_B + 0.01:
        raise RuntimeError(
            f"裏面テキストが安全域を超過: bottom={last_y:.2f} > SAFE_B={SAFE_B}"
        )


def _new_card_pdf(title: str, subject: str) -> FPDF:
    pdf = FPDF(orientation="P", unit="mm", format=(PAGE_W, PAGE_H))
    pdf.set_title(title)
    pdf.set_subject(subject)
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0, 0)
    pdf.c_margin = 0.0
    try:
        pdf.set_text_shaping(False)
    except Exception:
        pass
    return pdf


def _write_single_page_pdf(
    title: str,
    subject: str,
    draw: Callable[[FPDF], None],
    path: Path,
) -> None:
    pdf = _new_card_pdf(title, subject)
    register_fonts(pdf)
    pdf.add_page()
    draw(pdf)
    pdf.output(str(path))
    print("Wrote", path)


def main() -> None:
    ensure_fonts()

    _write_single_page_pdf(
        "Lexoria Business Card — Front",
        "表面（91×55mm 仕上げ・トンボ付き）",
        page_front,
        OUT_PDF_FRONT,
    )
    if not cormorant_available():
        print("Note: Cormorant Garamond unavailable — Lexoria / Founder use Inter fallback.")
    _write_single_page_pdf(
        "Lexoria Business Card — Back",
        "裏面（91×55mm 仕上げ・トンボ付き）",
        page_back,
        OUT_PDF_BACK,
    )


if __name__ == "__main__":
    main()
