from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import admin, auth, speech_generation, transcription
from app.core.config import settings
from app.db.bootstrap import ensure_database_schema, ensure_schema_extensions
from app.db.base import Base
from app.db.seed import seed_defaults
from app.db.session import SessionLocal, engine
from app.models import Setting, UploadRecord, User
from app.services.queue_service import queue_service


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_database_schema()
    Base.metadata.create_all(bind=engine)
    ensure_schema_extensions()
    settings.upload_path.mkdir(parents=True, exist_ok=True)
    settings.speech_output_path.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as session:
        seed_defaults(session)
    queue_service.start()
    yield
    await queue_service.stop()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

app.include_router(auth.router, prefix=settings.api_v1_prefix)
app.include_router(admin.router, prefix=settings.api_v1_prefix)
app.include_router(speech_generation.router, prefix=settings.api_v1_prefix)
app.include_router(transcription.router, prefix=settings.api_v1_prefix)


@app.get("/")
def health_check() -> dict[str, str]:
    return {"message": "Speech-to-text API is running"}
