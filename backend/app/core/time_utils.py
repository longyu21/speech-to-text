from datetime import datetime, timezone


LOCAL_TIMEZONE = datetime.now().astimezone().tzinfo or timezone.utc


def assume_utc_to_local(value: datetime) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(LOCAL_TIMEZONE)