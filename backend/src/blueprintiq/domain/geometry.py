"""Page space versus viewer space.

* **Page space** (stored everywhere as :class:`~blueprintiq.domain.models.BBox`): the
  visible area (CropBox) of the *unrotated* page, origin top-left, y down, points.
  This is what PyMuPDF reports, and it does not change when a page has /Rotate.
* **Viewer space** (:class:`ViewerRect`, never stored): the same page after the
  viewer turns it clockwise by /Rotate, origin top-left of what the reader sees.

Viewer space is used for reading order and will be used for on-screen overlays. It
is a separate type on purpose, so a viewer rectangle cannot be mistaken for evidence.
"""

from typing import NamedTuple

from blueprintiq.domain.models import BBox, PageInfo


class ViewerRect(NamedTuple):
    left: float
    top: float
    right: float
    bottom: float


def viewer_size(page: PageInfo) -> tuple[float, float]:
    """Width and height of the page as displayed."""
    if page.rotation in (90, 270):
        return (page.height_pt, page.width_pt)
    return (page.width_pt, page.height_pt)


def _point(x: float, y: float, page: PageInfo) -> tuple[float, float]:
    w, h = page.width_pt, page.height_pt
    match page.rotation:
        case 0:
            return (x, y)
        case 90:
            return (h - y, x)
        case 180:
            return (w - x, h - y)
        case 270:
            return (y, w - x)


def page_to_viewer(box: BBox, page: PageInfo) -> ViewerRect:
    """Map a page-space box to the rectangle a viewer shows after applying /Rotate."""
    ax, ay = _point(box.x0, box.y0, page)
    bx, by = _point(box.x1, box.y1, page)
    return ViewerRect(min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))
