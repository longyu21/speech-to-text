from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

from imageio_ffmpeg import get_ffmpeg_exe
from yt_dlp import DownloadError, YoutubeDL

from app.services.media_service import detect_media_source_type, is_supported_transcription_extension


@dataclass(slots=True)
class DownloadedRemoteMedia:
    file_path: Path
    original_filename: str
    source_type: str
    source_url: str


@dataclass(slots=True)
class PendingRemoteMedia:
    original_filename: str
    source_type: str
    source_url: str


def build_pending_remote_media(url: str) -> PendingRemoteMedia:
    parsed_url = urlparse(url)
    path_name = Path(unquote(parsed_url.path or "")).name.strip()
    if path_name:
        normalized_name = path_name
    else:
        normalized_name = f"remote-media-{uuid4().hex[:8]}.mp4"

    source_type = "video"
    if is_supported_transcription_extension(normalized_name):
        source_type = detect_media_source_type(normalized_name)
    elif "." not in Path(normalized_name).name:
        normalized_name = f"{normalized_name}.mp4"

    return PendingRemoteMedia(
        original_filename=normalized_name,
        source_type=source_type,
        source_url=url,
    )


def download_remote_media(
    url: str,
    download_dir: Path,
    max_size_bytes: int,
    progress_callback: Callable[[str, int], None] | None = None,
) -> DownloadedRemoteMedia:
    download_dir.mkdir(parents=True, exist_ok=True)
    template = download_dir / f"remote-{uuid4().hex}.%(ext)s"

    def emit_progress(stage: str, progress_percent: int) -> None:
        if progress_callback is None:
            return
        progress_callback(stage, progress_percent)

    def handle_progress(progress_data: dict[str, object]) -> None:
        status = str(progress_data.get("status") or "")
        if status == "downloading":
            total_bytes = progress_data.get("total_bytes") or progress_data.get("total_bytes_estimate")
            downloaded_bytes = progress_data.get("downloaded_bytes")
            try:
                total_value = float(total_bytes or 0)
                downloaded_value = float(downloaded_bytes or 0)
            except (TypeError, ValueError):
                emit_progress("downloading_media", 22)
                return
            if total_value > 0:
                ratio = max(0.0, min(1.0, downloaded_value / total_value))
                emit_progress("downloading_media", int(round(18 + ratio * 32)))
                return
            emit_progress("downloading_media", 22)
            return
        if status == "finished":
            emit_progress("downloading_media", 50)

    options = {
        "format": "bestvideo*[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best",
        "outtmpl": str(template),
        "ffmpeg_location": get_ffmpeg_exe(),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [handle_progress],
    }

    try:
        emit_progress("resolving_url", 10)
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=True)
            downloaded_path = _resolve_downloaded_file_path(info)
    except DownloadError as exc:
        raise ValueError(str(exc)) from exc

    if not downloaded_path.exists():
        raise ValueError("Downloaded media file could not be located")

    if not is_supported_transcription_extension(downloaded_path.name):
        downloaded_path.unlink(missing_ok=True)
        raise ValueError("Downloaded media format is not supported for transcription")

    file_size = downloaded_path.stat().st_size
    if file_size > max_size_bytes:
        downloaded_path.unlink(missing_ok=True)
        raise ValueError("Downloaded media exceeds configured upload limit")

    source_type = detect_media_source_type(downloaded_path.name)
    title = str(info.get("title") or downloaded_path.stem).strip() or downloaded_path.stem
    emit_progress("extracting_audio", 58)
    original_filename = f"{title}{downloaded_path.suffix.lower()}"
    return DownloadedRemoteMedia(
        file_path=downloaded_path,
        original_filename=original_filename,
        source_type=source_type,
        source_url=url,
    )


def _resolve_downloaded_file_path(info: dict[str, object]) -> Path:
    requested_downloads = info.get("requested_downloads")
    if isinstance(requested_downloads, list):
        for item in requested_downloads:
            if isinstance(item, dict) and item.get("filepath"):
                return Path(str(item["filepath"]))

    for key in ("filepath", "_filename"):
        value = info.get(key)
        if value:
            return Path(str(value))

    raise ValueError("Unable to resolve downloaded media path")