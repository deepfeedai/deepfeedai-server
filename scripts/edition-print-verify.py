"""Check the offline Chrome-generated edition PDFs. Requires pypdf.

Usage: python scripts/edition-print-verify.py /path/to/edition-print-qa-output
Visual inspection of rendered PDF pages is still required; this checks structural
paper size, content completeness, no empty pages, proof labels and hidden controls.
"""
import json
import sys
from pathlib import Path
from pypdf import PdfReader

root = Path(sys.argv[1])
cases = {
    "letter-short": (612, 792, 1),
    "a4-long": (595.28, 841.89, 3),
    "letter-long-ink": (612, 792, 2),
    "letter-proof": (612, 792, 1),
    "letter-missing-image": (612, 792, 1),
    "unavailable": (612, 792, 0),
}
paragraph_counts = {"letter-short": 2, "a4-long": 72, "letter-long-ink": 48, "letter-proof": 8, "letter-missing-image": 4}
results = []
for name, (width, height, article_count) in cases.items():
    reader = PdfReader(root / (name + ".pdf"))
    text = "\n".join(page.extract_text() for page in reader.pages)
    for page in reader.pages:
        assert abs(float(page.mediabox.width) - width) < 1, name + " wrong paper width"
        assert abs(float(page.mediabox.height) - height) < 1, name + " wrong paper height"
        assert page.extract_text().strip(), name + " blank page"
        assert "Print / Save PDF" not in page.extract_text(), name + " printed controls"
    for article_id in range(1, article_count + 1):
        assert text.count("START-ARTICLE-" + str(article_id)) == 1, name + " missing/duplicated start"
        assert text.count("END-ARTICLE-" + str(article_id)) == 1, name + " missing/duplicated ending"
    if name in paragraph_counts:
        normalized = " ".join(text.split())
        assert normalized.count("The newsroom examines evidence carefully") == paragraph_counts[name], name + " missing or duplicated body text"
    if name == "letter-proof":
        assert all("DRAFT" in "".join(page.extract_text().split()) for page in reader.pages), "Every proof page must carry DRAFT"
    if name == "letter-short":
        assert len(reader.pages) == 1, "Short issue should fit one page"
    if "long" in name:
        assert len(reader.pages) > 1, "Long article fixture did not span pages"
    if name == "unavailable":
        assert "START-ARTICLE" not in text and "not ready to print" in text
    results.append({"file": name + ".pdf", "pages": len(reader.pages), "characters": [len(p.extract_text()) for p in reader.pages], "articles_complete": article_count})
(root / "pdf-results.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
