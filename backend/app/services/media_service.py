import subprocess
import tempfile
from pathlib import Path
import re
from uuid import uuid4

from imageio_ffmpeg import get_ffmpeg_exe


VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".wmv", ".mpeg", ".mpg", ".3gp", ".m4v"}
SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa", ".lrc"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
GENERIC_MIME_TYPES = {"application/octet-stream", "binary/octet-stream"}
SUBTITLE_MIME_TYPES = {
    "application/x-subrip",
    "application/vtt",
    "text/vtt",
    "text/plain",
    "text/x-ssa",
    "text/x-ass",
    "application/x-ass",
    "application/x-ssa",
    *GENERIC_MIME_TYPES,
}
SUPPORTED_TRANSCRIPTION_EXTENSIONS = {
    *AUDIO_EXTENSIONS,
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".avi",
    ".wmv",
    ".mpeg",
    ".mpg",
    ".3gp",
    ".m4v",
    ".srt",
    ".vtt",
    ".ass",
    ".ssa",
    ".lrc",
}
SUPPORTED_TTS_OUTPUT_FORMATS = {"mp3", "wav", "m4a"}


def is_supported_transcription_extension(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_TRANSCRIPTION_EXTENSIONS


def is_subtitle_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUBTITLE_EXTENSIONS


def detect_media_source_type(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in SUBTITLE_EXTENSIONS:
        return "subtitle"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    raise ValueError("Unsupported media format")


def validate_upload_content(filename: str, content: bytes, content_type: str | None) -> str:
    source_type = detect_media_source_type(filename)
    normalized_content_type = (content_type or "").split(";")[0].strip().lower()

    if source_type == "subtitle":
        if normalized_content_type and normalized_content_type not in SUBTITLE_MIME_TYPES and not normalized_content_type.startswith("text/"):
            raise ValueError(f"MIME type does not match subtitle file: {normalized_content_type}")
        extracted_text = extract_text_from_subtitle(filename, content)
        if not extracted_text:
            raise ValueError("Subtitle file does not contain readable text")
        return source_type

    if source_type == "audio":
        if normalized_content_type and normalized_content_type not in GENERIC_MIME_TYPES and not normalized_content_type.startswith("audio/"):
            raise ValueError(f"MIME type does not match audio file: {normalized_content_type}")
    if source_type == "video":
        if normalized_content_type and normalized_content_type not in GENERIC_MIME_TYPES and not normalized_content_type.startswith("video/"):
            raise ValueError(f"MIME type does not match video file: {normalized_content_type}")

    if not _matches_binary_signature(filename, content):
        raise ValueError("File content does not match the selected extension")

    return source_type


def is_video_file(file_path: Path) -> bool:
    return file_path.suffix.lower() in VIDEO_EXTENSIONS


def normalize_tts_output_format(output_format: str | None) -> str:
    normalized = (output_format or "mp3").strip().lower()
    if normalized not in SUPPORTED_TTS_OUTPUT_FORMATS:
        raise ValueError("Unsupported speech output format")
    return normalized


def prepare_media_for_transcription(file_path: Path) -> Path:
    suffix = file_path.suffix.lower()
    if suffix not in SUPPORTED_TRANSCRIPTION_EXTENSIONS:
        raise ValueError("Unsupported transcription media format")

    with tempfile.TemporaryDirectory(prefix="stt-media-") as temp_dir:
        target_path = Path(temp_dir) / f"{file_path.stem}.wav"
        _run_ffmpeg([
            "-i",
            str(file_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(target_path),
        ])
        persisted_path = file_path.parent / f"{file_path.stem}-{uuid4().hex}.wav"
        persisted_path.write_bytes(target_path.read_bytes())
        return persisted_path


def extract_text_from_subtitle(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in SUBTITLE_EXTENSIONS:
        raise ValueError("Unsupported subtitle format")

    text = content.decode("utf-8", errors="ignore")
    text = text.replace("\ufeff", "")
    if suffix == ".vtt":
        text = text.replace("WEBVTT", "")

    cleaned_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if _is_subtitle_metadata(line, suffix):
            continue
        cleaned_lines.append(line)

    return "\n".join(cleaned_lines).strip()


def _is_subtitle_metadata(line: str, suffix: str) -> bool:
    if line.isdigit():
        return True
    if line.startswith(("NOTE", "STYLE", "Comment:", "Format:")):
        return True
    if suffix in {".ass", ".ssa"} and line.startswith(("[Script Info]", "[V4+ Styles]", "[Events]", "Dialogue:")):
        return line.startswith(("[Script Info]", "[V4+ Styles]", "[Events]"))
    if re.match(r"^\d{2}:\d{2}:\d{2}[,.]\d{2,3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{2,3}", line):
        return True
    if re.match(r"^\d{2}:\d{2}[.:]\d{2}\s*$", line):
        return True
    if re.match(r"^\d{2}:\d{2}[.:]\d{2}[\s-]+\d{2}:\d{2}[.:]\d{2}", line):
        return True
    return False


def _matches_binary_signature(filename: str, content: bytes) -> bool:
    suffix = Path(filename).suffix.lower()
    header = content[:64]
    if suffix == ".wav":
        return header.startswith(b"RIFF") and b"WAVE" in header
    if suffix == ".mp3":
        return header.startswith(b"ID3") or header[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}
    if suffix == ".flac":
        return header.startswith(b"fLaC")
    if suffix in {".ogg", ".opus"}:
        return header.startswith(b"OggS")
    if suffix in {".m4a", ".mp4", ".mov", ".m4v", ".3gp"}:
        return len(header) >= 12 and header[4:8] == b"ftyp"
    if suffix in {".webm", ".mkv"}:
        return header.startswith(b"\x1a\x45\xdf\xa3")
    if suffix == ".avi":
        return header.startswith(b"RIFF") and b"AVI" in header
    if suffix in {".wmv", ".wma"}:
        return header.startswith(bytes.fromhex("3026B2758E66CF11A6D900AA0062CE6C"))
    if suffix == ".aac":
        return len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xF0) == 0xF0
    if suffix in {".mpeg", ".mpg"}:
        return header.startswith(b"\x00\x00\x01\xba") or header.startswith(b"\x00\x00\x01\xb3")
    return True


def convert_audio_file(source_path: Path, output_dir: Path, output_format: str) -> Path:
    normalized_format = normalize_tts_output_format(output_format)
    if source_path.suffix.lower() == f".{normalized_format}":
        return source_path

    output_dir.mkdir(parents=True, exist_ok=True)
    target_path = output_dir / f"{uuid4().hex}.{normalized_format}"
    command = ["-i", str(source_path)]
    if normalized_format == "wav":
        command.extend(["-ac", "1", "-ar", "16000"])
    elif normalized_format == "mp3":
        command.extend(["-codec:a", "libmp3lame", "-b:a", "192k"])
    elif normalized_format == "m4a":
        command.extend(["-codec:a", "aac", "-b:a", "192k"])
    command.append(str(target_path))
    _run_ffmpeg(command)
    return target_path


def _run_ffmpeg(arguments: list[str]) -> None:
    ffmpeg_executable = get_ffmpeg_exe()
    command = [ffmpeg_executable, "-y", "-hide_banner", "-loglevel", "error", *arguments]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        error_message = completed.stderr.strip() or completed.stdout.strip() or "ffmpeg execution failed"
        raise RuntimeError(error_message)