from fastapi import Depends, FastAPI

from app.auth import get_current_user
from app.db import Base, engine
from app.models import User

Base.metadata.create_all(engine)

app = FastAPI(title="shop-api")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/users/me")
def me(user: User = Depends(get_current_user)) -> dict[str, object]:
    return {"id": user.id, "email": user.email, "name": user.name}
