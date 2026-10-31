"""Verify actual raster-image drawing in the offline CSP regression PDFs.
Usage: python scripts/edition-print-images-verify.py OUTPUT_DIRECTORY
Requires pypdf. No network, user content or printer access.
"""
from pathlib import Path
import json
import sys
from pypdf import PdfReader
from pypdf.generic import ContentStream

root = Path(sys.argv[1])
def drawings(stream, resources, reader, ancestors=()):
    count = 0
    for operands, operator in ContentStream(stream, reader).operations:
        if operator != b"Do":
            continue
        ref = resources.get("/XObject", {}).get(operands[0])
        if ref is None:
            continue
        obj = ref.get_object()
        if obj.get("/Subtype") == "/Image":
            assert int(obj["/Width"]) > 0 and int(obj["/Height"]) > 0
            count += 1
        elif obj.get("/Subtype") == "/Form":
            assert id(obj) not in ancestors, "Cyclic form XObject"
            count += drawings(obj, obj.get("/Resources", resources), reader, ancestors + (id(obj),))
    return count

results = []
for name in ["private-proof-five-images", "public-five-images"]:
    reader = PdfReader(root / (name + ".pdf"))
    counts = [drawings(page.get_contents(), page["/Resources"], reader) for page in reader.pages]
    assert sum(counts) == 5, f"{name}: expected 5 painted raster snapshots, got {counts}"
    text = "\n".join(page.extract_text() for page in reader.pages)
    for article_id in range(1, 6):
        assert text.count(f"START-ARTICLE-{article_id}") == 1
        assert text.count(f"END-ARTICLE-{article_id}") == 1
    assert "Image unavailable" not in text
    assert all(page.extract_text().strip() for page in reader.pages)
    if name.startswith("private"):
        assert all("DRAFT" in "".join(page.extract_text().split()) for page in reader.pages)
    results.append({"file": name + ".pdf", "pages": len(reader.pages), "raster_draws_per_page": counts, "raster_draws": sum(counts)})
(root / "image-pdf-results.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))