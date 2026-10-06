import csv
import hmac
import json
import math
import os
import random
import re
import sqlite3
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Generator
from zoneinfo import ZoneInfo

import psycopg
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory
from psycopg.rows import dict_row

load_dotenv()

ROOT = Path(__file__).resolve().parent
DATASET_DIR = ROOT / "dataset"
HISTORY_PATH = DATASET_DIR / "phc_queue_history.csv"
INTAKE_PATH = DATASET_DIR / "patient_intake.csv"
PHCS = [
    {"id": "phc-nagercoil", "name": "Nagercoil PHC", "district": "Kanniyakumari"},
    {"id": "phc-boothapandi", "name": "Boothapandi PHC", "district": "Kanniyakumari"},
    {"id": "phc-marthandam", "name": "Marthandam PHC", "district": "Kanniyakumari"},
]
SERVICES = (
    "General consultation",
    "Diabetes follow-up",
    "Blood pressure check",
    "Fever / cold",
    "Medicine refill",
    "Maternal and child health",
)
HISTORY_FIELDS = [
    "date",
    "day",
    "hour",
    "patients_waiting",
    "doctors_available",
    "avg_consultation_minutes",
    "new_patients",
    "revisit_patients",
    "waiting_minutes",
]
INTAKE_FIELDS = [
    "patient_id",
    "age",
    "service",
    "symptoms",
    "priority",
    "synthetic_demo_data",
]
PHC_TIMEZONE = ZoneInfo("Asia/Kolkata")

app = Flask(
    __name__,
    static_folder=str(ROOT / "public" / "static"),
    static_url_path="/static",
)
app.config["DATABASE_URL"] = os.getenv("DATABASE_URL", "").strip()
app.config["DATABASE"] = os.getenv("DATABASE_PATH", str(ROOT / "instance" / "namma_phc.sqlite3"))
app.config["DOCTORS_AVAILABLE"] = max(
    1, int(os.getenv("DOCTORS_AVAILABLE", "2"))
)


class DatabaseConfigurationError(RuntimeError):
    pass


class PostgresConnection:
    def __init__(self, connection: psycopg.Connection[Any]) -> None:
        self.connection = connection

    def execute(self, statement: str, parameters: tuple[Any, ...] = ()) -> Any:
        return self.connection.execute(
            re.sub(r"\?", "%s", statement),
            parameters,
        )

    def executescript(self, script: str) -> None:
        for statement in script.split(";"):
            if statement.strip():
                self.execute(statement)

    def commit(self) -> None:
        self.connection.commit()

    def rollback(self) -> None:
        self.connection.rollback()

    def close(self) -> None:
        self.connection.close()


def ensure_demo_datasets() -> None:
    """Create deterministic, privacy-safe demo CSV files when not present."""
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    if not HISTORY_PATH.exists():
        rng = random.Random(20261006)
        start = datetime.now(PHC_TIMEZONE).date() - timedelta(days=29)
        with HISTORY_PATH.open("w", newline="", encoding="utf-8") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=HISTORY_FIELDS)
            writer.writeheader()
            for day_offset in range(30):
                record_date = start + timedelta(days=day_offset)
                for hour in (8, 9, 10, 11, 12, 14, 15, 16):
                    doctors = 1 if hour in (12, 16) else 2
                    waiting = max(
                        0,
                        int(rng.gauss(11 + (hour in (9, 10, 11)) * 10, 5)),
                    )
                    consultation = round(rng.uniform(7.0, 13.0), 1)
                    new_patients = max(0, round(waiting * rng.uniform(0.38, 0.58)))
                    revisit_patients = max(0, waiting - new_patients)
                    wait_minutes = max(
                        0,
                        round(waiting / doctors * consultation * rng.uniform(0.8, 1.2)),
                    )
                    writer.writerow(
                        {
                            "date": record_date.isoformat(),
                            "day": record_date.strftime("%A"),
                            "hour": hour,
                            "patients_waiting": waiting,
                            "doctors_available": doctors,
                            "avg_consultation_minutes": consultation,
                            "new_patients": new_patients,
                            "revisit_patients": revisit_patients,
                            "waiting_minutes": wait_minutes,
                        }
                    )
    if not INTAKE_PATH.exists():
        rng = random.Random(20261007)
        services = list(SERVICES)
        symptom_examples = [
            "Fever since yesterday",
            "Follow-up for blood pressure",
            "Needs regular medicine refill",
            "Cough and sore throat",
            "Routine diabetes check",
            "Child has mild cold symptoms",
        ]
        with INTAKE_PATH.open("w", newline="", encoding="utf-8") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=INTAKE_FIELDS)
            writer.writeheader()
            for index in range(1, 61):
                writer.writerow(
                    {
                        "patient_id": f"DEMO-{index:03}",
                        "age": rng.randint(2, 82),
                        "service": rng.choice(services),
                        "symptoms": rng.choice(symptom_examples),
                        "priority": rng.choice(("routine", "routine", "routine", "priority")),
                        "synthetic_demo_data": "SYNTHETIC DEMO DATA",
                    }
                )


@contextmanager
def connect_db() -> Generator[Any, None, None]:
    if app.config["DATABASE_URL"]:
        connection = psycopg.connect(
            app.config["DATABASE_URL"],
            row_factory=dict_row,
            prepare_threshold=None,
            connect_timeout=8,
            sslmode="require",
        )
        db = PostgresConnection(connection)
    else:
        if os.getenv("VERCEL"):
            raise DatabaseConfigurationError(
                "DATABASE_URL is required on Vercel. Configure the Supabase transaction-pooler URL."
            )
        database_path = Path(app.config["DATABASE"])
        database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        db = connection
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize_database() -> None:
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS patients (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER,
                phone TEXT,
                phc_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tokens (
                id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL REFERENCES patients(id),
                token_number TEXT NOT NULL,
                service TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'waiting',
                created_at TEXT NOT NULL,
                UNIQUE(token_number, created_at)
            );
            CREATE TABLE IF NOT EXISTS token_sequences (
                sequence_key TEXT PRIMARY KEY,
                next_number INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS visit_passes (
                id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL REFERENCES patients(id),
                token_id TEXT NOT NULL REFERENCES tokens(id),
                phc_id TEXT NOT NULL,
                arrival_window TEXT NOT NULL,
                estimated_wait_minutes INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS consultations (
                id TEXT PRIMARY KEY,
                patient_id TEXT REFERENCES patients(id),
                visit_pass_id TEXT REFERENCES visit_passes(id),
                symptoms TEXT NOT NULL,
                summary_json TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue (
                id TEXT PRIMARY KEY,
                token_id TEXT NOT NULL UNIQUE REFERENCES tokens(id),
                phc_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'waiting',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_queue (
                id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                synced_at TEXT
            );
            """
        )
        legacy_sequences = db.execute(
            "SELECT SUBSTR(created_at, 1, 10) AS sequence_key, "
            "MAX(CAST(SUBSTR(token_number, 2) AS INTEGER)) AS max_number "
            "FROM tokens GROUP BY SUBSTR(created_at, 1, 10)"
        ).fetchall()
        for sequence in legacy_sequences:
            db.execute(
                "INSERT INTO token_sequences(sequence_key, next_number) VALUES (?, ?) "
                "ON CONFLICT(sequence_key) DO UPDATE SET next_number = "
                "CASE WHEN excluded.next_number > token_sequences.next_number "
                "THEN excluded.next_number ELSE token_sequences.next_number END",
                (sequence["sequence_key"], sequence["max_number"]),
            )


def load_history() -> list[dict[str, Any]]:
    ensure_demo_datasets()
    with HISTORY_PATH.open(newline="", encoding="utf-8") as csv_file:
        return [
            {
                **row,
                "hour": int(row["hour"]),
                "patients_waiting": int(row["patients_waiting"]),
                "doctors_available": int(row["doctors_available"]),
                "avg_consultation_minutes": float(row["avg_consultation_minutes"]),
                "new_patients": int(row["new_patients"]),
                "revisit_patients": int(row["revisit_patients"]),
                "waiting_minutes": int(row["waiting_minutes"]),
            }
            for row in csv.DictReader(csv_file)
        ]


def find_phc(phc_id: str) -> dict[str, str] | None:
    return next((phc for phc in PHCS if phc["id"] == phc_id), None)


def predict_queue(
    waiting_patients: int,
    doctors_available: int,
    at: datetime | None = None,
) -> dict[str, Any]:
    now = at or datetime.now(PHC_TIMEZONE)
    rows = load_history()
    matching = [
        row
        for row in rows
        if row["day"] == now.strftime("%A") and row["hour"] == now.hour
    ]
    if not matching:
        matching = rows
    avg_consultation = sum(
        row["avg_consultation_minutes"] for row in matching
    ) / len(matching)
    historical_wait = sum(row["waiting_minutes"] for row in matching) / len(matching)
    historical_queue = sum(row["patients_waiting"] for row in matching) / len(matching)
    workload_estimate = math.ceil(
        waiting_patients * avg_consultation / max(1, doctors_available)
    )
    historical_estimate = math.ceil(
        historical_wait * waiting_patients / max(1.0, historical_queue)
    )
    estimated = (
        0
        if waiting_patients == 0
        else max(1, round(workload_estimate * 0.65 + historical_estimate * 0.35))
    )
    status = "LOW" if estimated <= 20 else "MODERATE" if estimated <= 60 else "HIGH"
    start = now + timedelta(minutes=max(0, estimated - 10))
    end = now + timedelta(minutes=max(10, estimated + 5))
    return {
        "estimated_wait_minutes": estimated,
        "queue_status": status,
        "recommended_arrival_window": f"{start.strftime('%I:%M %p')}–{end.strftime('%I:%M %p')}",
        "doctors_available": doctors_available,
        "average_consultation_minutes": round(avg_consultation, 1),
    }


def current_waiting(phc_id: str, db: Any | None = None) -> int:
    if db is not None:
        row = db.execute(
            "SELECT COUNT(*) AS count FROM queue WHERE phc_id = ? AND status = 'waiting'",
            (phc_id,),
        ).fetchone()
        return int(row["count"])
    with connect_db() as connection:
        row = connection.execute(
            "SELECT COUNT(*) AS count FROM queue WHERE phc_id = ? AND status = 'waiting'",
            (phc_id,),
        ).fetchone()
        return int(row["count"])


def make_pass_data(visit_pass_id: str, token_number: str, payload: dict[str, Any]) -> dict[str, Any]:
    phc = find_phc(str(payload["phc_id"]))
    estimate = predict_queue(current_waiting(str(payload["phc_id"])), app.config["DOCTORS_AVAILABLE"])
    return {
        "visit_pass_id": visit_pass_id,
        "token": token_number,
        "name": payload["name"],
        "age": payload.get("age"),
        "phone": payload.get("phone", ""),
        "phc_id": phc["id"],
        "phc_name": phc["name"],
        "district": phc["district"],
        "service": payload["service"],
        "estimated_wait_minutes": estimate["estimated_wait_minutes"],
        "queue_status": estimate["queue_status"],
        "recommended_arrival_window": estimate["recommended_arrival_window"],
        "created_at": datetime.now(PHC_TIMEZONE).isoformat(timespec="minutes"),
        "synced": True,
    }


def store_booking(payload: dict[str, Any], pass_id: str | None = None) -> dict[str, Any]:
    pass_id = pass_id or str(uuid.uuid4())
    patient_id = str(uuid.uuid4())
    token_id = str(uuid.uuid4())
    now = datetime.now(PHC_TIMEZONE).isoformat(timespec="seconds")
    with connect_db() as db:
        existing = db.execute(
            "SELECT vp.id, t.token_number, p.name, p.age, p.phone, p.phc_id, "
            "t.service, vp.estimated_wait_minutes, vp.arrival_window, vp.created_at "
            "FROM visit_passes vp JOIN tokens t ON t.id = vp.token_id "
            "JOIN patients p ON p.id = vp.patient_id WHERE vp.id = ?",
            (pass_id,),
        ).fetchone()
        if existing:
            data = dict(existing)
            phc = find_phc(data["phc_id"])
            return {
                "visit_pass_id": data["id"],
                "token": data["token_number"],
                "name": data["name"],
                "age": data["age"],
                "phone": data["phone"] or "",
                "phc_id": data["phc_id"],
                "phc_name": phc["name"],
                "district": phc["district"],
                "service": data["service"],
                "estimated_wait_minutes": data["estimated_wait_minutes"],
                "recommended_arrival_window": data["arrival_window"],
                "created_at": data["created_at"],
                "synced": True,
            }
        waiting = current_waiting(payload["phc_id"], db)
        estimate = predict_queue(waiting, app.config["DOCTORS_AVAILABLE"])
        sequence_key = now[:10]
        sequence = db.execute(
            "INSERT INTO token_sequences(sequence_key, next_number) VALUES (?, 1) "
            "ON CONFLICT(sequence_key) DO UPDATE SET "
            "next_number = token_sequences.next_number + 1 RETURNING next_number",
            (sequence_key,),
        ).fetchone()
        token_number = f"T{sequence['next_number']:03}"
        phc = find_phc(payload["phc_id"])
        db.execute(
            "INSERT INTO patients(id, name, age, phone, phc_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (patient_id, payload["name"], payload.get("age"), payload.get("phone"), phc["id"], now),
        )
        db.execute(
            "INSERT INTO tokens(id, patient_id, token_number, service, created_at) VALUES (?, ?, ?, ?, ?)",
            (token_id, patient_id, token_number, payload["service"], now),
        )
        position = waiting + 1
        db.execute(
            "INSERT INTO queue(id, token_id, phc_id, position, updated_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), token_id, phc["id"], position, now),
        )
        db.execute(
            "INSERT INTO visit_passes(id, patient_id, token_id, phc_id, arrival_window, "
            "estimated_wait_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                pass_id,
                patient_id,
                token_id,
                phc["id"],
                estimate["recommended_arrival_window"],
                estimate["estimated_wait_minutes"],
                now,
            ),
        )
        return make_pass_data(pass_id, token_number, {**payload, "phc_id": phc["id"]})


def red_flags(symptoms: str) -> list[str]:
    lowered = symptoms.casefold()
    phrases = {
        "chest pain": ("chest pain", "pain in chest", "chest tightness"),
        "severe breathing difficulty": (
            "severe breathing",
            "cannot breathe",
            "can't breathe",
            "difficulty breathing",
            "breathlessness",
        ),
        "unconsciousness": ("unconscious", "not responding", "passed out"),
        "severe bleeding": ("severe bleeding", "heavy bleeding", "bleeding heavily"),
    }
    return [
        label
        for label, variants in phrases.items()
        if any(variant in lowered for variant in variants)
    ]


def summarize_symptoms(symptoms: str, visit_pass_id: str | None = None) -> dict[str, Any]:
    flags = red_flags(symptoms)
    sentences = [part.strip() for part in symptoms.replace("\n", ". ").split(".") if part.strip()]
    duration = next(
        (
            phrase
            for phrase in (
                "today",
                "since yesterday",
                "for 2 days",
                "for two days",
                "for 3 days",
                "for three days",
                "for a week",
                "since morning",
            )
            if phrase in symptoms.casefold()
        ),
        "Not specified",
    )
    summary = {
        "summary": (sentences[0][:180] if sentences else "Patient-reported symptoms recorded."),
        "duration": duration,
        "symptoms": sentences[:6],
        "suggested_service_lane": (
            "Emergency assessment now"
            if flags
            else "General consultation"
        ),
        "red_flags": flags,
        "urgent": bool(flags),
        "disclaimer": "AI assistance only. Not a medical diagnosis.",
    }
    consultation_id = None
    if visit_pass_id:
        with connect_db() as db:
            visit = db.execute(
                "SELECT patient_id FROM visit_passes WHERE id = ?", (visit_pass_id,)
            ).fetchone()
            if visit:
                consultation_id = str(uuid.uuid4())
                db.execute(
                    "INSERT INTO consultations(id, patient_id, visit_pass_id, symptoms, summary_json, priority, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        consultation_id,
                        visit["patient_id"],
                        visit_pass_id,
                        symptoms,
                        json.dumps(summary),
                        int(bool(flags)),
                        datetime.now(PHC_TIMEZONE).isoformat(timespec="seconds"),
                    ),
                )
    if consultation_id:
        summary["_consultation_id"] = consultation_id
    return summary


def save_consultation_summary(consultation_id: str | None, summary: dict[str, Any]) -> None:
    if consultation_id:
        with connect_db() as db:
            db.execute(
                "UPDATE consultations SET summary_json = ? WHERE id = ?",
                (json.dumps(summary), consultation_id),
            )


ensure_demo_datasets()
if app.config["DATABASE_URL"] or not os.getenv("VERCEL"):
    initialize_database()


@app.get("/")
def home():
    return render_template("index.html", phcs=PHCS, services=SERVICES)


@app.get("/manifest.webmanifest")
def manifest():
    return jsonify(
        {
            "name": "NAMMA PHC AI",
            "short_name": "NAMMA PHC",
            "description": "Arrive at the right time at your Primary Health Centre.",
            "start_url": "/",
            "display": "standalone",
            "background_color": "#f5f8f6",
            "theme_color": "#086b5c",
            "icons": [
                {
                    "src": "/static/icon.svg",
                    "sizes": "any",
                    "type": "image/svg+xml",
                    "purpose": "any maskable",
                }
            ],
        }
    )


@app.get("/service-worker.js")
def service_worker():
    return send_from_directory(ROOT / "public", "service-worker.js", mimetype="application/javascript")


@app.get("/api/health")
def health():
    with connect_db() as db:
        db.execute("SELECT 1")
    return jsonify({"ok": True, "service": "NAMMA PHC AI", "database": "connected"})


@app.get("/api/queue")
def queue():
    phc_id = request.args.get("phc_id", PHCS[0]["id"])
    if not find_phc(phc_id):
        return jsonify({"error": "Select a valid PHC."}), 400
    with connect_db() as db:
        waiting = db.execute(
            "SELECT t.token_number, q.status FROM queue q "
            "JOIN tokens t ON t.id = q.token_id "
            "WHERE q.phc_id = ? AND q.status IN ('waiting', 'called') "
            "ORDER BY CASE q.status WHEN 'called' THEN 0 ELSE 1 END, q.position",
            (phc_id,),
        ).fetchall()
        current = next((row["token_number"] for row in waiting if row["status"] == "called"), "—")
    estimate = predict_queue(
        sum(row["status"] == "waiting" for row in waiting),
        app.config["DOCTORS_AVAILABLE"],
    )
    return jsonify(
        {
            "phc_id": phc_id,
            "current_token": current,
            "waiting_patients": sum(row["status"] == "waiting" for row in waiting),
            **estimate,
        }
    )


@app.post("/api/token")
def token():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    phc_id = str(data.get("phc_id") or PHCS[0]["id"])
    service = str(data.get("service") or data.get("purpose") or SERVICES[0]).strip()
    age = data.get("age")
    phone = "".join(character for character in str(data.get("phone") or "") if character.isdigit())
    if not name:
        return jsonify({"error": "Enter the patient's name."}), 400
    if len(name) > 80:
        return jsonify({"error": "Name must be 80 characters or fewer."}), 400
    if not find_phc(phc_id):
        return jsonify({"error": "Select a valid PHC."}), 400
    if service not in SERVICES:
        return jsonify({"error": "Select a valid service."}), 400
    if age not in (None, ""):
        try:
            age = int(age)
        except (TypeError, ValueError):
            return jsonify({"error": "Age must be a number."}), 400
        if age < 0 or age > 120:
            return jsonify({"error": "Age must be between 0 and 120."}), 400
    else:
        age = None
    if phone and len(phone) not in (10,):
        return jsonify({"error": "Enter a 10-digit phone number or leave it blank."}), 400
    pass_id = str(data.get("visit_pass_id") or uuid.uuid4())
    try:
        uuid.UUID(pass_id)
    except ValueError:
        return jsonify({"error": "Visit pass ID is invalid."}), 400
    result = store_booking(
        {"name": name, "age": age, "phone": phone, "phc_id": phc_id, "service": service},
        pass_id,
    )
    return jsonify(result), 201


@app.get("/api/visit-pass/<pass_id>")
def get_visit_pass(pass_id: str):
    with connect_db() as db:
        row = db.execute(
            "SELECT vp.id, vp.phc_id, vp.arrival_window, vp.estimated_wait_minutes, "
            "vp.created_at, t.token_number, t.service, p.name, p.age, p.phone "
            "FROM visit_passes vp JOIN tokens t ON t.id = vp.token_id "
            "JOIN patients p ON p.id = vp.patient_id WHERE vp.id = ?",
            (pass_id,),
        ).fetchone()
    if not row:
        return jsonify({"error": "Visit Pass was not found on the server."}), 404
    phc = find_phc(row["phc_id"])
    return jsonify(
        {
            "visit_pass_id": row["id"],
            "token": row["token_number"],
            "name": row["name"],
            "age": row["age"],
            "phone": row["phone"] or "",
            "phc_id": row["phc_id"],
            "phc_name": phc["name"],
            "district": phc["district"],
            "service": row["service"],
            "estimated_wait_minutes": row["estimated_wait_minutes"],
            "recommended_arrival_window": row["arrival_window"],
            "created_at": row["created_at"],
            "synced": True,
        }
    )


@app.post("/api/symptoms")
def symptoms():
    data = request.get_json(silent=True) or {}
    text = str(data.get("symptoms") or "").strip()
    if not text:
        return jsonify({"error": "Describe the symptoms first."}), 400
    if len(text) > 2000:
        return jsonify({"error": "Symptoms must be 2,000 characters or fewer."}), 400
    summary = summarize_symptoms(text, data.get("visit_pass_id"))
    summary.pop("_consultation_id", None)
    return jsonify(summary)


@app.post("/api/ai/summarize")
def ai_summarize():
    data = request.get_json(silent=True) or {}
    text = str(data.get("symptoms") or "").strip()
    if not text:
        return jsonify({"error": "Describe the symptoms first."}), 400
    if len(text) > 2000:
        return jsonify({"error": "Symptoms must be 2,000 characters or fewer."}), 400
    local_summary = summarize_symptoms(text, data.get("visit_pass_id"))
    consultation_id = local_summary.pop("_consultation_id", None)
    if local_summary["urgent"]:
        local_summary["source"] = "rule-based safety check"
        local_summary["summary"] = (
            "A possible emergency warning sign was mentioned. Please seek urgent in-person "
            "assessment now; do not wait for an online response."
        )
        save_consultation_summary(consultation_id, local_summary)
        return jsonify(local_summary)
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        local_summary["source"] = "offline intake summary"
        save_consultation_summary(consultation_id, local_summary)
        return jsonify(local_summary)
    try:
        from groq import Groq

        response = Groq(api_key=api_key).chat.completions.create(
            model=os.getenv("GROQ_MODEL", "openai/gpt-oss-20b"),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a PHC pre-consultation intake assistant, not a clinician. "
                        "Never diagnose diseases, prescribe, or claim certainty. Return only "
                        "valid JSON with keys summary, duration, symptoms (array), and "
                        "suggested_service_lane. Summarize only what the patient reports. "
                        "Use a short, simple intake summary and preserve unknown duration as "
                        "'Not specified'."
                    ),
                },
                {"role": "user", "content": text},
            ],
            temperature=0.2,
            max_tokens=220,
            response_format={"type": "json_object"},
        )
        generated = json.loads(response.choices[0].message.content or "{}")
        summary = {
            **local_summary,
            "summary": str(generated.get("summary") or local_summary["summary"])[:400],
            "duration": str(generated.get("duration") or local_summary["duration"])[:80],
            "symptoms": generated.get("symptoms")
            if isinstance(generated.get("symptoms"), list)
            else local_summary["symptoms"],
            "suggested_service_lane": str(
                generated.get("suggested_service_lane")
                or local_summary["suggested_service_lane"]
            )[:100],
            "source": "Groq AI",
        }
        save_consultation_summary(consultation_id, summary)
        return jsonify(summary)
    except (ValueError, KeyError, TypeError, AttributeError):
        app.logger.exception("Groq returned an invalid intake summary.")
        return jsonify({"error": "AI summary could not be parsed. Please retry or tell PHC staff."}), 502
    except Exception:
        app.logger.exception("Groq intake summary request failed.")
        return jsonify({"error": "AI is temporarily unavailable. Please tell PHC staff your symptoms."}), 503


@app.post("/api/sync")
def sync():
    data = request.get_json(silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list) or len(items) > 100:
        return jsonify({"error": "Send a list of up to 100 pending Visit Passes."}), 400
    synced = []
    failures = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            failures.append({"index": index, "error": "Visit Pass data must be an object."})
            continue
        try:
            required = ("visit_pass_id", "name", "phc_id")
            if any(not str(item.get(key) or "").strip() for key in required):
                raise ValueError("Visit Pass is missing an ID, patient name or PHC.")
            service = str(item.get("service") or SERVICES[0])
            if service not in SERVICES:
                raise ValueError("Visit Pass contains an unknown service.")
            age_value = item.get("age")
            age = int(age_value) if age_value not in (None, "") else None
            if age is not None and not 0 <= age <= 120:
                raise ValueError("Age must be between 0 and 120.")
            phone = "".join(character for character in str(item.get("phone") or "") if character.isdigit())
            if phone and len(phone) != 10:
                raise ValueError("Phone number must have 10 digits.")
            pass_id = str(uuid.UUID(str(item["visit_pass_id"])))
            phc_id = str(item["phc_id"])
            if not find_phc(phc_id):
                raise ValueError("Visit Pass contains an unknown PHC.")
            payload = {
                "name": str(item["name"]).strip()[:80],
                "age": age,
                "phone": phone,
                "phc_id": phc_id,
                "service": service,
            }
            result = store_booking(payload, pass_id)
            with connect_db() as db:
                db.execute(
                    "INSERT INTO sync_queue(id, payload_json, status, created_at, synced_at) "
                    "VALUES (?, ?, 'synced', ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, "
                    "status = excluded.status, synced_at = excluded.synced_at",
                    (
                        pass_id,
                        json.dumps(item),
                        datetime.now(PHC_TIMEZONE).isoformat(timespec="seconds"),
                        datetime.now(PHC_TIMEZONE).isoformat(timespec="seconds"),
                    ),
                )
            synced.append(result)
        except (ValueError, TypeError, sqlite3.Error, psycopg.Error) as error:
            app.logger.warning("Unable to sync offline Visit Pass %s: %s", index, error)
            failures.append({"index": index, "error": str(error)})
    status_code = 207 if failures and synced else 400 if failures else 200
    return jsonify({"synced": synced, "failures": failures, "synced_count": len(synced)}), status_code


@app.post("/api/staff/call-next")
def call_next():
    data = request.get_json(silent=True) or {}
    phc_id = str(data.get("phc_id") or PHCS[0]["id"])
    if not find_phc(phc_id):
        return jsonify({"error": "Select a valid PHC."}), 400
    now = datetime.now(PHC_TIMEZONE).isoformat(timespec="seconds")
    with connect_db() as db:
        existing = db.execute(
            "SELECT id FROM queue WHERE phc_id = ? AND status = 'called' ORDER BY updated_at DESC LIMIT 1",
            (phc_id,),
        ).fetchone()
        if existing:
            db.execute(
                "UPDATE queue SET status = 'completed', updated_at = ? WHERE id = ?",
                (now, existing["id"]),
            )
            db.execute(
                "UPDATE tokens SET status = 'completed' WHERE id = "
                "(SELECT token_id FROM queue WHERE id = ?)",
                (existing["id"],),
            )
        next_patient = db.execute(
            "SELECT q.id, q.token_id, t.token_number, p.name FROM queue q "
            "JOIN tokens t ON t.id = q.token_id JOIN patients p ON p.id = t.patient_id "
            "WHERE q.phc_id = ? AND q.status = 'waiting' ORDER BY q.position, t.created_at LIMIT 1",
            (phc_id,),
        ).fetchone()
        if not next_patient:
            return jsonify({"error": "There are no waiting patients to call."}), 409
        db.execute(
            "UPDATE queue SET status = 'called', updated_at = ? WHERE id = ?",
            (now, next_patient["id"]),
        )
        db.execute("UPDATE tokens SET status = 'called' WHERE id = ?", (next_patient["token_id"],))
    return jsonify({"token": next_patient["token_number"], "name": next_patient["name"]})


@app.get("/api/dashboard")
def dashboard():
    phc_id = request.args.get("phc_id", PHCS[0]["id"])
    if not find_phc(phc_id):
        return jsonify({"error": "Select a valid PHC."}), 400
    with connect_db() as db:
        date_filter = "t.created_at LIKE ?" if app.config["DATABASE_URL"] else "date(t.created_at) = date('now', 'localtime')"
        date_parameter = f"{datetime.now(PHC_TIMEZONE).date().isoformat()}%" if app.config["DATABASE_URL"] else None
        tokens = db.execute(
            "SELECT t.id, t.token_number, t.service, t.status, t.created_at, "
            "p.id AS patient_id, p.name, p.age, p.phone, vp.id AS visit_pass_id, "
            "vp.estimated_wait_minutes, vp.arrival_window "
            "FROM tokens t JOIN patients p ON p.id = t.patient_id "
            "LEFT JOIN visit_passes vp ON vp.token_id = t.id "
            f"WHERE p.phc_id = ? AND {date_filter} ORDER BY t.created_at DESC",
            (phc_id, date_parameter) if date_parameter is not None else (phc_id,),
        ).fetchall()
        current = db.execute(
            "SELECT t.token_number FROM queue q JOIN tokens t ON t.id = q.token_id "
            "WHERE q.phc_id = ? AND q.status = 'called' ORDER BY q.updated_at DESC LIMIT 1",
            (phc_id,),
        ).fetchone()
        priority = db.execute(
            "SELECT c.symptoms, c.summary_json, c.created_at, p.name, t.token_number "
            "FROM consultations c LEFT JOIN patients p ON p.id = c.patient_id "
            "LEFT JOIN visit_passes vp ON vp.id = c.visit_pass_id "
            "LEFT JOIN tokens t ON t.id = vp.token_id "
            "WHERE c.priority = 1 AND p.phc_id = ? ORDER BY c.created_at DESC LIMIT 10",
            (phc_id,),
        ).fetchall()
        latest_intake = db.execute(
            "SELECT c.symptoms, c.summary_json, c.created_at, p.name, t.token_number "
            "FROM consultations c LEFT JOIN patients p ON p.id = c.patient_id "
            "LEFT JOIN visit_passes vp ON vp.id = c.visit_pass_id "
            "LEFT JOIN tokens t ON t.id = vp.token_id "
            "WHERE p.phc_id = ? ORDER BY c.created_at DESC LIMIT 1",
            (phc_id,),
        ).fetchone()
    history = load_history()
    today = datetime.now(PHC_TIMEZONE).date()
    daily_history = [
        row for row in history if datetime.fromisoformat(row["date"]).date() == today
    ]
    if not daily_history:
        daily_history = [row for row in history if row["day"] == today.strftime("%A")]
    avg_wait = round(
        sum(row["waiting_minutes"] for row in daily_history)
        / max(1, len(daily_history))
    )
    avg_consult = round(
        sum(row["avg_consultation_minutes"] for row in daily_history)
        / max(1, len(daily_history)),
        1,
    )
    by_hour: dict[int, list[int]] = defaultdict(list)
    by_date: dict[str, list[int]] = defaultdict(list)
    for row in history:
        by_hour[row["hour"]].append(row["patients_waiting"])
        by_date[row["date"]].append(row["waiting_minutes"])
    busiest = sorted(
        (
            {"hour": f"{hour:02}:00", "average_waiting": round(sum(values) / len(values))}
            for hour, values in by_hour.items()
        ),
        key=lambda item: item["average_waiting"],
        reverse=True,
    )[:4]
    trend = [
        {
            "date": record_date,
            "average_wait_minutes": round(sum(values) / len(values)),
        }
        for record_date, values in sorted(by_date.items())[-7:]
    ]
    active_rows = [dict(row) for row in tokens]
    waiting = current_waiting(phc_id)
    prediction = predict_queue(waiting, app.config["DOCTORS_AVAILABLE"])
    staff_patients = [
        {
            "token": row["token_number"],
            "name": row["name"],
            "service": row["service"],
            "status": row["status"],
            "estimated_wait_minutes": row["estimated_wait_minutes"] or 0,
            "visit_pass_id": row["visit_pass_id"],
        }
        for row in active_rows
    ]
    return jsonify(
        {
            "phc_id": phc_id,
            "today_patients": len(active_rows),
            "waiting_patients": waiting,
            "current_token": current["token_number"] if current else "—",
            "estimated_wait_minutes": prediction["estimated_wait_minutes"],
            "average_waiting_minutes": avg_wait,
            "average_consultation_minutes": avg_consult,
            "priority_cases": [
                {
                    "name": row["name"] or "Patient",
                    "token": row["token_number"] or "—",
                    "symptoms": row["symptoms"],
                    "created_at": row["created_at"],
                }
                for row in priority
            ],
            "latest_intake": (
                {
                    "name": latest_intake["name"] or "Patient",
                    "token": latest_intake["token_number"] or "—",
                    "symptoms": latest_intake["symptoms"],
                    "summary": json.loads(latest_intake["summary_json"] or "{}"),
                }
                if latest_intake
                else None
            ),
            "patients": staff_patients,
            "busiest_hours": busiest,
            "queue_trend": trend,
            "synthetic_data_label": "SYNTHETIC DEMO DATA",
        }
    )


@app.before_request
def protect_staff_routes():
    if not (
        request.path == "/api/dashboard"
        or request.path == "/api/staff/call-next"
        or request.path.startswith("/api/visit-pass/")
    ):
        return None
    expected_code = os.getenv("STAFF_ACCESS_CODE", "").strip()
    if not expected_code and os.getenv("VERCEL"):
        return jsonify({"error": "Set STAFF_ACCESS_CODE in the Vercel project environment variables."}), 503
    supplied_code = request.headers.get("X-Staff-Access-Code", "")
    if expected_code and not hmac.compare_digest(supplied_code, expected_code):
        return jsonify({"error": "Enter a valid staff access code to view PHC records."}), 401
    return None


@app.errorhandler(DatabaseConfigurationError)
def database_configuration_error(error: DatabaseConfigurationError):
    app.logger.error("%s", error)
    return jsonify({"error": str(error)}), 503


# Compatibility routes retained for the original QuickToken page integrations.
@app.get("/api/status")
def legacy_status():
    data = queue().get_json()
    data["current"] = data["current_token"]
    data["ahead"] = data["waiting_patients"]
    data["estimated_minutes"] = data["estimated_wait_minutes"]
    return jsonify(data)


@app.get("/api/patients")
def patients():
    with INTAKE_PATH.open(newline="", encoding="utf-8") as csv_file:
        rows = list(csv.DictReader(csv_file))
    return jsonify(
        [
            {
                "id": row["patient_id"],
                "name": row["patient_id"],
                "age": int(row["age"]),
                "village": "Synthetic demo",
                "condition": row["service"],
                "priority": "High" if row["priority"] == "priority" else "Low",
            }
            for row in rows
        ]
    )


@app.post("/api/ai")
def legacy_ai():
    response = ai_summarize()
    if isinstance(response, tuple):
        body, status_code = response[0], response[1]
        data = body.get_json()
    else:
        status_code = response.status_code
        data = response.get_json()
    data["answer"] = data.get("summary") or data.get("error", "")
    return jsonify(data), status_code


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "").lower() == "true",
    )
