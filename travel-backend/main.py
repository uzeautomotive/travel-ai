import logging
import os
import warnings
from datetime import date, datetime, timedelta, timezone

import bcrypt
import joblib
import jwt
import pandas as pd
import psycopg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg.rows import dict_row
from typing import Literal

from pydantic import BaseModel, Field

# .env файлаас тохиргоо унших
load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
MODEL_PATH = os.getenv("MODEL_PATH")  # Prompt 6-д загвар ачаалахад ашиглана
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL .env файлд тохируулагдаагүй байна")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET .env файлд тохируулагдаагүй байна")

logger = logging.getLogger("travel")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------- Эрэлт таамаглах загвар ----------
# Colab-д сургасан баганын нэр, дараалал яг ижил байх ёстой
MODEL_FEATURES = ["price_per_day", "guide_experience", "days"]


def load_model():
    if not MODEL_PATH:
        logger.warning("MODEL_PATH тохируулагдаагүй: таамаглал ажиллахгүй")
        return None
    path = MODEL_PATH if os.path.isabs(MODEL_PATH) else os.path.join(BASE_DIR, MODEL_PATH)
    try:
        with warnings.catch_warnings():
            # Colab (sklearn 1.6) ба энд суусан хувилбар зөрөхөд гардаг анхааруулга.
            # LinearRegression-д нөлөөгүй гэдгийг гар тооцоотой тулгаж шалгасан.
            warnings.filterwarnings("ignore", message=".*Trying to unpickle estimator.*")
            model = joblib.load(path)
    except Exception:
        logger.exception("Загвар ачаалж чадсангүй: %s", path)
        return None
    if list(getattr(model, "feature_names_in_", [])) != MODEL_FEATURES:
        logger.error("Загварын баганууд таарахгүй байна: %s", getattr(model, "feature_names_in_", None))
        return None
    return model


demand_model = load_model()


def predict_demand(rows: list[list[float]]) -> list[float]:
    """Олон мөрийг нэг дор таамаглана. Сөрөг бол 0, 1 оронтой бутархай."""
    if demand_model is None:
        raise HTTPException(status_code=503, detail="Таамаглалын загвар ачаалагдаагүй байна")
    df = pd.DataFrame(rows, columns=MODEL_FEATURES)
    return [max(0.0, round(float(p), 1)) for p in demand_model.predict(df)]

app = FastAPI(title="Travel Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_conn():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


@app.get("/health")
def health():
    try:
        with get_conn() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "database": "ok"}
    except Exception:
        raise HTTPException(status_code=503, detail="Database unavailable")


# Аяллыг хөтөчийн нэр, захиалгын тоотой нь хамт авах SELECT
TOUR_SELECT = """
    SELECT t.tour_id, t.name, t.destination, t.days, t.price, t.start_date,
           t.guide_id, g.full_name AS guide_name,
           (SELECT COUNT(*) FROM bookings b WHERE b.tour_id = t.tour_id) AS booking_count
    FROM tours t
    LEFT JOIN guides g ON g.guide_id = t.guide_id
"""


@app.get("/tours")
def list_tours():
    # Шинээр нэмсэн нь хамгийн дээр
    with get_conn() as conn:
        return conn.execute(TOUR_SELECT + " ORDER BY t.tour_id DESC").fetchall()


class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/login")
def login(body: LoginRequest):
    with get_conn() as conn:
        admin = conn.execute(
            "SELECT admin_id, email, password_hash FROM admins WHERE lower(email) = lower(%s)",
            (body.email.strip(),),
        ).fetchone()

    # Имэйл эсвэл нууц үг аль нь буруу байсныг ялгаж хэлэхгүй (аюулгүй байдлын үүднээс)
    if not admin or not bcrypt.checkpw(
        body.password.encode("utf-8"), admin["password_hash"].encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Имэйл эсвэл нууц үг буруу байна")

    expires = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    token = jwt.encode(
        {"sub": str(admin["admin_id"]), "email": admin["email"], "exp": expires},
        JWT_SECRET,
        algorithm="HS256",
    )
    return {"access_token": token, "token_type": "bearer"}


bearer_scheme = HTTPBearer(auto_error=False)


def require_admin(creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    """Authorization: Bearer <token> толгойг шалгана. Буруу эсвэл хугацаа нь дууссан бол 401."""
    if creds is None:
        raise HTTPException(status_code=401, detail="Нэвтрээгүй байна")
    try:
        return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Токен хүчингүй эсвэл хугацаа нь дууссан")


@app.get("/admin/stats")
def admin_stats(admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        counts = conn.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM tours)                             AS tours,
                (SELECT COUNT(*) FROM bookings)                          AS bookings,
                (SELECT COUNT(*) FROM bookings WHERE status = 'pending') AS pending,
                (SELECT COALESCE(SUM(amount), 0) FROM payments)          AS revenue
            """
        ).fetchone()

        pending_list = conn.execute(
            """
            SELECT b.booking_id, b.booked_at, b.people,
                   c.full_name AS customer, t.name AS tour
            FROM bookings b
            JOIN customers c ON c.customer_id = b.customer_id
            JOIN tours t     ON t.tour_id = b.tour_id
            WHERE b.status = 'pending'
            ORDER BY b.booked_at DESC, b.booking_id DESC
            LIMIT 5
            """
        ).fetchall()

    return {
        "tours": counts["tours"],
        "bookings": counts["bookings"],
        "pending": counts["pending"],
        "revenue": float(counts["revenue"]),
        "pending_bookings": pending_list,
    }


# ===================== Аялал CRUD =====================

class TourIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    destination: str | None = Field(default=None, max_length=50)
    days: int = Field(gt=0)
    price: float = Field(gt=0)
    start_date: date | None = None
    guide_id: int | None = None


def get_tour(conn, tour_id: int):
    tour = conn.execute(TOUR_SELECT + " WHERE t.tour_id = %s", (tour_id,)).fetchone()
    if not tour:
        raise HTTPException(status_code=404, detail="Аялал олдсонгүй")
    return tour


def check_guide(conn, guide_id: int | None):
    if guide_id is not None and not conn.execute(
        "SELECT 1 FROM guides WHERE guide_id = %s", (guide_id,)
    ).fetchone():
        raise HTTPException(status_code=400, detail="Сонгосон хөтөч олдсонгүй")


@app.post("/tours", status_code=201)
def create_tour(body: TourIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        check_guide(conn, body.guide_id)
        row = conn.execute(
            """
            INSERT INTO tours (name, destination, days, price, start_date, guide_id)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING tour_id
            """,
            (body.name.strip(), body.destination, body.days, body.price, body.start_date, body.guide_id),
        ).fetchone()
        return get_tour(conn, row["tour_id"])


@app.put("/tours/{tour_id}")
def update_tour(tour_id: int, body: TourIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        check_guide(conn, body.guide_id)
        updated = conn.execute(
            """
            UPDATE tours
            SET name = %s, destination = %s, days = %s, price = %s, start_date = %s, guide_id = %s
            WHERE tour_id = %s
            RETURNING tour_id
            """,
            (body.name.strip(), body.destination, body.days, body.price, body.start_date, body.guide_id, tour_id),
        ).fetchone()
        if not updated:
            raise HTTPException(status_code=404, detail="Аялал олдсонгүй")
        return get_tour(conn, tour_id)


@app.delete("/tours/{tour_id}", status_code=204)
def delete_tour(tour_id: int, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        tour = get_tour(conn, tour_id)
        if tour["booking_count"] > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Энэ аялалд {tour['booking_count']} захиалга байгаа тул устгах боломжгүй",
            )
        try:
            conn.execute("DELETE FROM tours WHERE tour_id = %s", (tour_id,))
        except psycopg.errors.ForeignKeyViolation:
            # Шалгасны дараа яг тэр агшинд захиалга орж ирсэн тохиолдол
            raise HTTPException(status_code=409, detail="Энэ аялалд захиалга байгаа тул устгах боломжгүй")


# ===================== Захиалга CRUD =====================

BookingStatus = Literal["pending", "confirmed", "cancelled"]

# Захиалгыг үйлчлүүлэгч, аялал, төлсөн дүнтэй нь хамт авах SELECT
BOOKING_SELECT = """
    SELECT b.booking_id, b.booked_at, b.people, b.status,
           b.tour_id, t.name AS tour_name,
           b.customer_id, c.full_name AS customer_name,
           COALESCE(p.paid, 0)::float AS paid_amount
    FROM bookings b
    JOIN tours t     ON t.tour_id = b.tour_id
    JOIN customers c ON c.customer_id = b.customer_id
    LEFT JOIN (SELECT booking_id, SUM(amount) AS paid FROM payments GROUP BY booking_id) p
           ON p.booking_id = b.booking_id
"""


class BookingIn(BaseModel):
    tour_id: int
    customer_id: int
    people: int = Field(gt=0)
    status: BookingStatus = "pending"


class StatusIn(BaseModel):
    status: BookingStatus


def get_booking(conn, booking_id: int):
    row = conn.execute(BOOKING_SELECT + " WHERE b.booking_id = %s", (booking_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
    return row


def check_booking_refs(conn, body: BookingIn):
    if not conn.execute("SELECT 1 FROM tours WHERE tour_id = %s", (body.tour_id,)).fetchone():
        raise HTTPException(status_code=400, detail="Сонгосон аялал олдсонгүй")
    if not conn.execute("SELECT 1 FROM customers WHERE customer_id = %s", (body.customer_id,)).fetchone():
        raise HTTPException(status_code=400, detail="Сонгосон үйлчлүүлэгч олдсонгүй")


@app.get("/bookings")
def list_bookings(status: BookingStatus | None = None, admin: dict = Depends(require_admin)):
    # Сүүлийн 50 захиалга, төлөвөөр шүүж болно
    sql = BOOKING_SELECT
    params: list = []
    if status:
        sql += " WHERE b.status = %s"
        params.append(status)
    sql += " ORDER BY b.booked_at DESC, b.booking_id DESC LIMIT 50"
    with get_conn() as conn:
        return conn.execute(sql, params).fetchall()


@app.post("/bookings", status_code=201)
def create_booking(body: BookingIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        check_booking_refs(conn, body)
        row = conn.execute(
            """
            INSERT INTO bookings (tour_id, customer_id, people, status)
            VALUES (%s, %s, %s, %s)
            RETURNING booking_id
            """,
            (body.tour_id, body.customer_id, body.people, body.status),
        ).fetchone()
        return get_booking(conn, row["booking_id"])


@app.put("/bookings/{booking_id}")
def update_booking(booking_id: int, body: BookingIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        check_booking_refs(conn, body)
        updated = conn.execute(
            """
            UPDATE bookings SET tour_id = %s, customer_id = %s, people = %s, status = %s
            WHERE booking_id = %s
            RETURNING booking_id
            """,
            (body.tour_id, body.customer_id, body.people, body.status, booking_id),
        ).fetchone()
        if not updated:
            raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
        return get_booking(conn, booking_id)


@app.patch("/bookings/{booking_id}/status")
def update_booking_status(booking_id: int, body: StatusIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        updated = conn.execute(
            "UPDATE bookings SET status = %s WHERE booking_id = %s RETURNING booking_id",
            (body.status, booking_id),
        ).fetchone()
        if not updated:
            raise HTTPException(status_code=404, detail="Захиалга олдсонгүй")
        return get_booking(conn, booking_id)


@app.delete("/bookings/{booking_id}", status_code=204)
def delete_booking(booking_id: int, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        booking = get_booking(conn, booking_id)
        if booking["paid_amount"] > 0:
            raise HTTPException(
                status_code=409,
                detail="Энэ захиалгад төлбөр төлөгдсөн тул устгах боломжгүй. Оронд нь «Цуцлах»-ыг ашиглана уу.",
            )
        try:
            conn.execute("DELETE FROM bookings WHERE booking_id = %s", (booking_id,))
        except psycopg.errors.ForeignKeyViolation:
            raise HTTPException(
                status_code=409,
                detail="Энэ захиалгад төлбөр төлөгдсөн тул устгах боломжгүй. Оронд нь «Цуцлах»-ыг ашиглана уу.",
            )


# ===================== Үйлчлүүлэгч CRUD =====================

CUSTOMER_SELECT = """
    SELECT c.customer_id, c.full_name, c.country, c.email,
           (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.customer_id) AS booking_count
    FROM customers c
"""

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class CustomerIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=100)
    country: str | None = Field(default=None, max_length=50)
    email: str | None = Field(default=None, max_length=100, pattern=EMAIL_PATTERN)


def get_customer(conn, customer_id: int):
    row = conn.execute(CUSTOMER_SELECT + " WHERE c.customer_id = %s", (customer_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Үйлчлүүлэгч олдсонгүй")
    return row


@app.get("/customers")
def list_customers(admin: dict = Depends(require_admin)):
    # Шинээр нэмсэн нь хамгийн дээр
    with get_conn() as conn:
        return conn.execute(CUSTOMER_SELECT + " ORDER BY c.customer_id DESC").fetchall()


@app.post("/customers", status_code=201)
def create_customer(body: CustomerIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO customers (full_name, country, email) VALUES (%s, %s, %s) RETURNING customer_id",
            (body.full_name.strip(), body.country, body.email),
        ).fetchone()
        return get_customer(conn, row["customer_id"])


@app.put("/customers/{customer_id}")
def update_customer(customer_id: int, body: CustomerIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        updated = conn.execute(
            """
            UPDATE customers SET full_name = %s, country = %s, email = %s
            WHERE customer_id = %s RETURNING customer_id
            """,
            (body.full_name.strip(), body.country, body.email, customer_id),
        ).fetchone()
        if not updated:
            raise HTTPException(status_code=404, detail="Үйлчлүүлэгч олдсонгүй")
        return get_customer(conn, customer_id)


@app.delete("/customers/{customer_id}", status_code=204)
def delete_customer(customer_id: int, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        customer = get_customer(conn, customer_id)
        msg = f"Энэ үйлчлүүлэгч {customer['booking_count']} захиалгатай тул устгах боломжгүй"
        if customer["booking_count"] > 0:
            raise HTTPException(status_code=409, detail=msg)
        try:
            conn.execute("DELETE FROM customers WHERE customer_id = %s", (customer_id,))
        except psycopg.errors.ForeignKeyViolation:
            raise HTTPException(status_code=409, detail="Энэ үйлчлүүлэгч захиалгатай тул устгах боломжгүй")


# ===================== Хөтөч CRUD =====================

GUIDE_SELECT = """
    SELECT g.guide_id, g.full_name, g.language, g.experience_years,
           (SELECT COUNT(*) FROM tours t WHERE t.guide_id = g.guide_id) AS tour_count
    FROM guides g
"""


class GuideIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=100)
    language: str | None = Field(default=None, max_length=30)
    experience_years: int | None = Field(default=None, ge=0, le=80)


def get_guide(conn, guide_id: int):
    row = conn.execute(GUIDE_SELECT + " WHERE g.guide_id = %s", (guide_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Хөтөч олдсонгүй")
    return row


@app.get("/guides")
def list_guides(admin: dict = Depends(require_admin)):
    # Шинээр нэмсэн нь хамгийн дээр
    with get_conn() as conn:
        return conn.execute(GUIDE_SELECT + " ORDER BY g.guide_id DESC").fetchall()


@app.post("/guides", status_code=201)
def create_guide(body: GuideIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        row = conn.execute(
            "INSERT INTO guides (full_name, language, experience_years) VALUES (%s, %s, %s) RETURNING guide_id",
            (body.full_name.strip(), body.language, body.experience_years),
        ).fetchone()
        return get_guide(conn, row["guide_id"])


@app.put("/guides/{guide_id}")
def update_guide(guide_id: int, body: GuideIn, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        updated = conn.execute(
            """
            UPDATE guides SET full_name = %s, language = %s, experience_years = %s
            WHERE guide_id = %s RETURNING guide_id
            """,
            (body.full_name.strip(), body.language, body.experience_years, guide_id),
        ).fetchone()
        if not updated:
            raise HTTPException(status_code=404, detail="Хөтөч олдсонгүй")
        return get_guide(conn, guide_id)


@app.delete("/guides/{guide_id}", status_code=204)
def delete_guide(guide_id: int, admin: dict = Depends(require_admin)):
    with get_conn() as conn:
        guide = get_guide(conn, guide_id)
        if guide["tour_count"] > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Энэ хөтөч {guide['tour_count']} аялалд хариуцагчаар бүртгэлтэй тул устгах боломжгүй",
            )
        try:
            conn.execute("DELETE FROM guides WHERE guide_id = %s", (guide_id,))
        except psycopg.errors.ForeignKeyViolation:
            raise HTTPException(status_code=409, detail="Энэ хөтөч аялалд бүртгэлтэй тул устгах боломжгүй")


# ===================== Эрэлт таамаглах =====================

@app.get("/predict-demand")
def predict_demand_endpoint(
    price_per_day: float = Query(gt=0),
    guide_experience: float = Query(ge=0),
    days: int = Query(gt=0),
    admin: dict = Depends(require_admin),
):
    [prediction] = predict_demand([[price_per_day, guide_experience, days]])
    return {
        "price_per_day": price_per_day,
        "guide_experience": guide_experience,
        "days": days,
        "predicted_bookings": prediction,
    }


@app.get("/demand/tours")
def demand_tours(limit: int = Query(default=10, ge=1, le=150), admin: dict = Depends(require_admin)):
    """Хамгийн их захиалгатай аяллууд: бодит захиалга ба загварын таамаглал."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT t.tour_id, t.name, t.destination, t.days, t.price,
                   g.full_name AS guide_name, g.experience_years AS guide_experience,
                   COUNT(b.booking_id) AS actual_bookings
            FROM tours t
            LEFT JOIN guides g   ON g.guide_id = t.guide_id
            LEFT JOIN bookings b ON b.tour_id = t.tour_id
            GROUP BY t.tour_id, g.guide_id
            ORDER BY actual_bookings DESC, t.tour_id DESC
            LIMIT %s
            """,
            (limit,),
        ).fetchall()

    # Хөтөчгүй эсвэл туршлага нь тодорхойгүй аялалд таамаглал гаргахгүй
    ready = [r for r in rows if r["guide_experience"] is not None and r["days"]]
    preds = predict_demand(
        [[float(r["price"]) / r["days"], r["guide_experience"], r["days"]] for r in ready]
    ) if ready else []
    pred_by_id = {r["tour_id"]: p for r, p in zip(ready, preds)}

    for r in rows:
        r["price_per_day"] = round(float(r["price"]) / r["days"], 1) if r["days"] else None
        r["predicted_bookings"] = pred_by_id.get(r["tour_id"])
    return rows
