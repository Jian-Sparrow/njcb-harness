"""Exercise PDF rendering and PPTX generation using the installed wheels."""
import io
import pathlib
import tempfile

import pymupdf
from pptx import Presentation
from pptx.util import Inches

with tempfile.TemporaryDirectory(prefix="njcb-pdf-ppt-") as directory:
    pdf = pathlib.Path(directory) / "sample.pdf"
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 72), "NJCB offline PDF to PPT")
    document.save(pdf)
    document.close()
    presentation = Presentation()
    with pymupdf.open(pdf) as document:
        assert "NJCB offline" in document[0].get_text()
        image = document[0].get_pixmap().tobytes("png")
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    slide.shapes.add_picture(io.BytesIO(image), 0, 0, height=Inches(7))
    pptx = pathlib.Path(directory) / "sample.pptx"
    presentation.save(pptx)
    reopened = Presentation(pptx)
    assert len(reopened.slides) == 1
    assert len(reopened.slides[0].shapes) == 1
print("PASS: PDF text extraction, page rendering, PPTX generation and reopening")
