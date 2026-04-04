from pathlib import Path
from uuid import uuid4


def save_upload_file(upload_dir: Path, original_filename: str, content: bytes) -> tuple[str, Path]:
    suffix = Path(original_filename).suffix.lower()
    stored_filename = f"{uuid4().hex}{suffix}"
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_path = upload_dir / stored_filename
    file_path.write_bytes(content)
    return stored_filename, file_path


def remove_upload_file(file_path: Path) -> None:
    if file_path.exists():
        file_path.unlink()
