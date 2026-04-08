# -*- coding: utf-8 -*-
"""
最小再現用 PDF（デバッグ専用）

- 背景・QR・トンボ・装飾なし
- Noto Sans JP のみ（Google 静的 TTF を優先、無ければローカル OTF）
- 左寄せ・幅固定・1 行 = 1 回の cell（自動改行なし）
- Inter は使わない

出力: Lexoria-BusinessCard-MINIMAL.pdf
"""
from __future__ import annotations

import urllib.request
from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

ROOT = Path(__file__).resolve().parent
FONTS = ROOT / "fonts"

NOTO_OTF_REG = FONTS / "NotoSansJP-Regular.otf"
NOTO_OTF_BOLD = FONTS / "NotoSansJP-Bold.otf"
NOTO_TTF_REG = FONTS / "NotoSansJP-Google-Regular.ttf"
NOTO_TTF_BOLD = FONTS / "NotoSansJP-Google-Bold.ttf"

# fonts.googleapis.com CSS 由来の gstatic 直リンク（日本語グリフ入り静的 TTF）
URL_REG = "https://fonts.gstatic.com/s/notosansjp/v56/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75s.ttf"
URL_BOLD = "https://fonts.gstatic.com/s/notosansjp/v56/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFPYk75s.ttf"

OUT_MIN = ROOT / "Lexoria-BusinessCard-MINIMAL.pdf"


def ensure_noto_ttf() -> tuple[Path, Path]:
    if NOTO_TTF_REG.exists() and NOTO_TTF_BOLD.exists():
        return NOTO_TTF_REG, NOTO_TTF_BOLD
    FONTS.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(URL_REG, NOTO_TTF_REG)
    urllib.request.urlretrieve(URL_BOLD, NOTO_TTF_BOLD)
    return NOTO_TTF_REG, NOTO_TTF_BOLD


def resolve_noto() -> tuple[Path, Path]:
    try:
        return ensure_noto_ttf()
    except OSError:
        pass
    if NOTO_OTF_REG.exists() and NOTO_OTF_BOLD.exists():
        return NOTO_OTF_REG, NOTO_OTF_BOLD
    raise SystemExit(
        "Noto フォントが見つかりません。\n"
        f"  配置: {NOTO_OTF_REG} / {NOTO_OTF_BOLD}\n"
        "  またはネットワークで TTF を取得できる状態にしてください。"
    )


def main() -> None:
    reg, bold = resolve_noto()

    pdf = FPDF(orientation="P", unit="mm", format=(97.0, 61.0))
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0, 0)
    pdf.c_margin = 0.0
    try:
        pdf.set_text_shaping(False)
    except Exception:
        pass

    pdf.add_page()
    pdf.add_font("NotoJP", "", str(reg))
    pdf.add_font("NotoJP", "B", str(bold))

    x = 8.0
    w = 81.0
    y = 10.0

    rows: list[tuple[str, float, str, str]] = [
        ("", 5.0, 3.5, "いわね はると"),
        ("B", 11.0, 8.0, "岩根亘杜"),
        ("B", 8.5, 5.0, "Lexoria"),
        ("", 6.0, 4.0, "初回相談メモを10秒で整理"),
        ("", 5.0, 3.5, "support@lexoriaai.com"),
    ]

    for style, pt, h_mm, txt in rows:
        pdf.set_font("NotoJP", style, pt)
        pdf.set_text_color(26, 26, 46)
        pdf.set_xy(x, y)
        pdf.cell(
            w,
            h_mm,
            txt,
            align="L",
            new_x=XPos.LEFT,
            new_y=YPos.TOP,
        )
        y += h_mm + 1.5

    pdf.output(str(OUT_MIN))
    print("Wrote", OUT_MIN)


if __name__ == "__main__":
    main()
