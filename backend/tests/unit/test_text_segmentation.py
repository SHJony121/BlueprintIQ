"""Line segmentation is a pure function over positioned characters (no PDF needed)."""

from blueprintiq.extraction.text_layer import GAP_SPLIT_EM, PositionedChar, split_at_gaps

SIZE = 10.0


def row(*pieces: tuple[str, float]) -> list[PositionedChar]:
    """Characters laid out left to right; each piece is (text, x where it starts)."""
    chars: list[PositionedChar] = []
    for text, start in pieces:
        x = start
        for c in text:
            width = 2.78 if c == " " else 6.0
            chars.append(PositionedChar(c, (x, 0.0, x + width, 12.0), SIZE))
            x += width
    return chars


def texts(segments: list[list[PositionedChar]]) -> list[str]:
    return ["".join(c.text for c in seg) for seg in segments]


def test_contiguous_text_stays_one_segment() -> None:
    assert texts(split_at_gaps(row(("THICKNESS: 4 mm", 0.0)), (1.0, 0.0))) == ["THICKNESS: 4 mm"]


def test_real_space_characters_never_split_even_when_many() -> None:
    chars = row(("THICKNESS:      4 mm", 0.0))  # six real spaces > 1 em of whitespace
    assert texts(split_at_gaps(chars, (1.0, 0.0))) == ["THICKNESS:      4 mm"]


def test_empty_gap_of_one_em_or_more_splits() -> None:
    first = row(("THICKNESS: 4 mm", 0.0))
    end = first[-1].bbox[2]
    chars = first + row(("MATERIAL: SS400", end + GAP_SPLIT_EM * SIZE))
    assert texts(split_at_gaps(chars, (1.0, 0.0))) == ["THICKNESS: 4 mm", "MATERIAL: SS400"]


def test_empty_gap_just_under_one_em_does_not_split() -> None:
    first = row(("A:", 0.0))
    end = first[-1].bbox[2]
    chars = first + row(("B", end + GAP_SPLIT_EM * SIZE - 0.01))
    assert texts(split_at_gaps(chars, (1.0, 0.0))) == ["A:B"]


def test_wide_synthesized_space_splits_and_is_dropped() -> None:
    chars = row(("LENGTH: 1 mm", 0.0))
    end = chars[-1].bbox[2]
    chars.append(PositionedChar(" ", (end, 0.0, end + 30.0, 12.0), SIZE))
    chars += row(("NOTE", end + 30.0))
    assert texts(split_at_gaps(chars, (1.0, 0.0))) == ["LENGTH: 1 mm", "NOTE"]


def test_edge_whitespace_is_trimmed_from_segments() -> None:
    chars = row(("  MATERIAL: SS400  ", 0.0))
    assert texts(split_at_gaps(chars, (1.0, 0.0))) == ["MATERIAL: SS400"]


def test_whitespace_only_input_gives_no_segments() -> None:
    assert split_at_gaps(row(("   ", 0.0)), (1.0, 0.0)) == []


def test_vertical_text_uses_the_y_axis() -> None:
    # Text running upward (dir 0,-1): each next glyph sits above the previous one.
    a = PositionedChar("A", (0.0, 90.0, 12.0, 100.0), SIZE)
    b = PositionedChar("B", (0.0, 80.0, 12.0, 90.0), SIZE)
    far = PositionedChar("C", (0.0, 50.0, 12.0, 60.0), SIZE)  # 2 em gap above B
    assert texts(split_at_gaps([a, b, far], (0.0, -1.0))) == ["AB", "C"]
