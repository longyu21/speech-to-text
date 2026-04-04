from io import BytesIO

from docx import Document


def build_transcript_docx(title: str, language_label: str, transcript_text: str) -> bytes:
    document = Document()
    document.add_heading(title, level=1)
    document.add_paragraph(f"Detected language: {language_label}")
    document.add_paragraph("")
    document.add_paragraph(transcript_text)
    output = BytesIO()
    document.save(output)
    return output.getvalue()
