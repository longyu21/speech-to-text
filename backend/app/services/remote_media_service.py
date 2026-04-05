from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

from imageio_ffmpeg import get_ffmpeg_exe
from yt_dlp import DownloadError, YoutubeDL

from app.core.config import settings
from app.services.media_service import detect_media_source_type, is_supported_transcription_extension


YOUTUBE_HOST_KEYWORDS = ("youtube.com", "youtu.be")
COOKIE_BROWSER_CANDIDATES = ("firefox", "edge", "chrome", "brave")


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
        "js_runtimes": {"node": {}},
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"],
                "player_skip": ["webpage", "configs"],
            }
        },
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        },
    }

    try:
        emit_progress("resolving_url", 10)
        info, downloaded_path = _download_with_fallback(url, options)
    except Exception as exc:
        raise ValueError(_normalize_remote_download_error(url, exc)) from exc

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


def _download_with_fallback(url: str, base_options: dict[str, object]) -> tuple[dict[str, object], Path]:
    errors: list[str] = []
    ignored_cookie_errors: list[str] = []
    for strategy in _build_download_strategies(url, base_options):
        try:
            with YoutubeDL(strategy) as downloader:
                info = downloader.extract_info(url, download=True)
                return info, _resolve_downloaded_file_path(info)
        except Exception as exc:
            message = str(exc).strip()
            if _is_ignorable_cookie_error(message):
                ignored_cookie_errors.append(message)
                continue
            errors.append(message)
            continue

    if errors:
        raise DownloadError(errors[-1])
    if ignored_cookie_errors:
        raise DownloadError(ignored_cookie_errors[-1])
    raise DownloadError("Remote media download failed")


def _build_download_strategies(url: str, base_options: dict[str, object]) -> list[dict[str, object]]:
    strategies: list[dict[str, object]] = []
    if not _is_youtube_url(url):
        return [deepcopy(base_options)]

    cookie_file = settings.youtube_cookies_file
    if cookie_file is not None and cookie_file.exists():
        strategy = deepcopy(base_options)
        strategy["cookiefile"] = str(cookie_file)
        strategies.append(strategy)

    strategies.append(deepcopy(base_options))

    for browser_name in COOKIE_BROWSER_CANDIDATES:
        strategy = deepcopy(base_options)
        strategy["cookiesfrombrowser"] = (browser_name,)
        strategies.append(strategy)
    return strategies


def _is_youtube_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(keyword in host for keyword in YOUTUBE_HOST_KEYWORDS)


def _normalize_remote_download_error(url: str, error: Exception) -> str:
    message = str(error).strip() or "Remote media download failed"
    if _is_youtube_url(url) and (
        "n challenge solving failed" in message
        or "no supported javascript runtime" in message.lower()
        or "external js" in message.lower()
    ):
        return (
            "当前环境缺少 YouTube 所需的 JS challenge 求解能力。"
            "请确认后端环境已安装 Node.js 20+，并重新执行 backend/requirements.txt 中的依赖安装后重试。"
        )
    if "Failed to decrypt with DPAPI" in message:
        return (
            "无法解密 Chromium 浏览器里的登录 Cookie。请优先使用 Firefox 登录态，"
            "或在 backend/.env 中配置 YOUTUBE_COOKIES_PATH 指向手工导出的 YouTube cookies.txt 后重试。"
        )
    if "Could not copy Chrome cookie database" in message:
        return (
            "无法读取 Chrome 的登录 Cookie，通常是因为 Chrome 正在运行并锁定了 Cookie 数据库。"
            "请先完全关闭 Chrome 后重试，或改用已登录 YouTube 的 Edge/Firefox。"
        )
    if _is_youtube_url(url) and "Sign in to confirm you're not a bot" in message:
        return (
            "YouTube 当前要求登录态验证。系统已自动尝试读取本机 Edge、Chrome、Brave、Firefox 的登录 Cookie。"
            "如果仍然失败，请先在这些浏览器中登录 YouTube 后重试，或关闭浏览器后再试一次。"
        )
    return message


def _is_ignorable_cookie_error(message: str) -> bool:
    normalized = message.lower()
    return (
        "could not find" in normalized and "cookies database" in normalized
    ) or "failed to load cookies" in normalized or "could not copy chrome cookie database" in normalized