import json
from functools import lru_cache
from pathlib import Path

from app.core.config import settings
from app.db.seed import JAPANESE_TRANSCRIPT_CORRECTIONS_KEY, JAPANESE_TTS_DICTIONARY_KEY, SPEECH_FAVORITE_VOICES_KEY_PREFIX, SPEECH_RECENT_VOICES_KEY_PREFIX
from app.db.session import SessionLocal
from app.models.setting import Setting


def parse_dictionary_payload(raw_value: str | None) -> dict[str, str]:
    if not raw_value:
        return {}
    try:
        parsed = json.loads(raw_value)
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        str(key).strip(): str(value).strip()
        for key, value in parsed.items()
        if str(key).strip() and str(value).strip()
    }


def invalidate_dictionary_settings_cache() -> None:
    get_japanese_tts_dictionary.cache_clear()
    get_japanese_transcript_corrections.cache_clear()


def parse_string_list_payload(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    try:
        parsed = json.loads(raw_value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for item in parsed:
        value = str(item).strip()
        if not value or value in seen:
            continue
        normalized.append(value)
        seen.add(value)
    return normalized


@lru_cache(maxsize=1)
def get_japanese_tts_dictionary() -> dict[str, str]:
    return _get_dictionary_setting(JAPANESE_TTS_DICTIONARY_KEY, settings.japanese_tts_dictionary_file)


@lru_cache(maxsize=1)
def get_japanese_transcript_corrections() -> dict[str, str]:
    return _get_dictionary_setting(JAPANESE_TRANSCRIPT_CORRECTIONS_KEY, settings.japanese_transcript_corrections_file)


def _get_dictionary_setting(setting_key: str, fallback_file: Path) -> dict[str, str]:
    with SessionLocal() as db:
        setting = db.query(Setting).filter(Setting.key == setting_key).first()
        if setting is not None:
            return parse_dictionary_payload(setting.value)
    if fallback_file.exists():
        return parse_dictionary_payload(fallback_file.read_text(encoding="utf-8"))
    return {}


def build_speech_favorite_voices_key(user_id: int) -> str:
    return f"{SPEECH_FAVORITE_VOICES_KEY_PREFIX}:{user_id}"


def get_user_favorite_voice_ids(user_id: int) -> list[str]:
    return _get_string_list_setting(build_speech_favorite_voices_key(user_id))


def build_speech_recent_voices_key(user_id: int) -> str:
    return f"{SPEECH_RECENT_VOICES_KEY_PREFIX}:{user_id}"


def get_user_recent_voice_ids(user_id: int) -> list[str]:
    return _get_string_list_setting(build_speech_recent_voices_key(user_id))


def _get_string_list_setting(setting_key: str) -> list[str]:
    with SessionLocal() as db:
        setting = db.query(Setting).filter(Setting.key == setting_key).first()
        if setting is None:
            return []
        return parse_string_list_payload(setting.value)