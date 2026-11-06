"""Marks document text as untrusted data before it reaches a model."""

import re

UNTRUSTED_DOCUMENT_TAG = "untrusted_document"

# Loose on purpose: a model may read "< / UNTRUSTED document" as a real tag even
# though it is not well-formed, so a document must not be able to contain one.
_TAG_LOOKALIKE = re.compile(r"<\s*/?\s*untrusted[\s_-]*document(?:\s*>)?", re.IGNORECASE)


def wrap_untrusted_document(text: str) -> str:
    """Enclose `text` in the tag, removing anything inside that could close it early."""
    neutralised = _TAG_LOOKALIKE.sub("[tag removed]", text)
    return f"<{UNTRUSTED_DOCUMENT_TAG}>\n{neutralised}\n</{UNTRUSTED_DOCUMENT_TAG}>"
