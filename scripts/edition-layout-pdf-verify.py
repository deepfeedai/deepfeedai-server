"""Verify the 32 synthetic layout PDFs from edition-print-qa.cjs (requires pypdf)."""
import json
import sys
from pathlib import Path
from pypdf import PdfReader

root = Path(sys.argv[1])
results = []
for file in sorted(root.glob('layout-*.pdf')):
    reader = PdfReader(file)
    width, height = (595.28, 841.89) if '-A4-' in file.name else (612, 792)
    pages = [page.extract_text() for page in reader.pages]
    text = '\n'.join(pages)
    for page, content in zip(reader.pages, pages):
        assert abs(float(page.mediabox.width) - width) < 1, file.name
        assert abs(float(page.mediabox.height) - height) < 1, file.name
        assert len(content.replace('DRAFT', '').strip()) > 30, file.name + ' empty page'
        assert 'Print / Save PDF' not in content, file.name + ' printed controls'
        if 'newspaper' not in file.name:
            editorial = content.replace('Private editorial proof. Not for public distribution. This edition contains saved article', '').replace('versions. Printed and downloaded copies cannot be recalled.', '')
            assert len(''.join(editorial.split()).replace('DRAFT', '')) > 20, file.name + ' footer-only page'
    assert 'Meet the contributors' in text, file.name
    assert 'Assigned writer for this article' in text, file.name
    if 'morning-brief' in file.name:
        assert 'EXCERPT' in text, file.name
        assert 'Saved description with supported evidence' in text, file.name
        assert 'A safe fallback excerpt with citation' in text, file.name
        assert 'END-ARTICLE-' not in text, file.name
    else:
        for article_id in (1, 2):
            assert text.count('START-ARTICLE-' + str(article_id)) == 1, file.name
            assert text.count('END-ARTICLE-' + str(article_id)) == 1, file.name
    if '-ink.pdf' in file.name:
        assert 'long-source-path-' not in text, file.name
    else:
        assert 'Saved supporting source' in text, file.name
    results.append({'file': file.name, 'pages': len(pages), 'characters': [len(p) for p in pages]})
assert len(results) == 32, 'Expected all 32 layout fixtures'
for mode in ('private', 'public'):
    file = root / ('full-article-' + mode + '.pdf')
    reader = PdfReader(file)
    text = '\n'.join(page.extract_text() for page in reader.pages)
    assert 'FULL SAVED ARTICLE VIEW' in text, file.name
    assert 'END-ARTICLE-1' in text and 'START-ARTICLE-2' not in text, file.name
    assert 'Print / Save PDF' not in text, file.name
(root / 'layout-pdf-results.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
