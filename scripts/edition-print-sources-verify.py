"""Verify actual PDF citation destinations, external links and printed source URLs.
Usage: python scripts/edition-print-sources-verify.py OUTPUT_DIRECTORY
Requires pypdf. All fixtures are synthetic; no network or printer access.
"""
from pathlib import Path
import json
import sys
from pypdf import PdfReader

root = Path(sys.argv[1])
expected_urls = {f"https://example.invalid/article-{article_id}/source-{part}" for article_id in (51, 52) for part in ("one", "two")}
expected_destinations = {f"/edition-ref-{article_id}-{number}" for article_id in (51, 52) for number in (1, 2)}
results = []
for mode in ("proof", "published"):
    name = "sources-" + mode
    reader = PdfReader(root / (name + ".pdf"))
    text = "\n".join(page.extract_text() for page in reader.pages)
    urls, destinations = [], []
    for page in reader.pages:
        for reference in page.get("/Annots", []):
            annotation = reference.get_object()
            if annotation.get("/Subtype") != "/Link":
                continue
            action = annotation.get("/A")
            if action:
                assert action.get("/S") == "/URI", "Unexpected active PDF action"
                urls.append(str(action["/URI"]))
            if annotation.get("/Dest"):
                destinations.append(str(annotation["/Dest"]))
    assert len(urls) == 4 and set(urls) == expected_urls
    assert len(destinations) == 4 and set(destinations) == expected_destinations
    assert expected_destinations.issubset(reader.named_destinations)
    assert all(url in text for url in expected_urls), "Source URLs must remain visible on paper"
    assert "Source details unavailable for [9]" in text
    assert "DO_NOT_PRINT_TOKEN" not in text
    assert all(page.extract_text().strip() for page in reader.pages)
    if mode == "proof":
        assert all("DRAFT" in "".join(page.extract_text().split()) for page in reader.pages)
    results.append({"file": name + ".pdf", "pages": len(reader.pages), "internal_citation_links": len(destinations), "external_source_links": len(urls), "printed_urls": len(expected_urls)})
(root / "sources-pdf-results.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))