# NAMMA PHC AI

“Don’t wait at the PHC. Arrive at the right time.”

A lightweight Flask prototype for PHC queue estimates, locally saved Visit Passes, pre-consultation intake, and staff/admin queue views. The UI has no CDN or image dependencies and the service worker caches the application shell for repeat offline use.

## Run on Windows

From the project folder, install the listed dependencies once:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt
```

If you do not already have a `.env`, copy the example without overwriting an existing local key file, then start the app:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
.\venv\Scripts\python.exe app.py
```

Open <http://127.0.0.1:5000>. After initial setup, the app starts with the single command `.\venv\Scripts\python.exe app.py`.

Groq is optional. Set `GROQ_API_KEY` in `.env` on the Flask server to enable structured AI summaries; the key is never sent to the browser. Without it, the app returns a local intake summary and retains the red-flag safety check. Set `GROQ_MODEL` to choose a Groq-supported model and `DOCTORS_AVAILABLE` to configure the demo PHC staffing count.

## Offline demo

1. Load the page once while online so the service worker can cache the shell.
2. Create a Visit Pass, then disable the browser/device network. The Visit Pass remains in local storage and can be reopened; a pass created offline is marked pending.
3. Re-enable the network. Pending passes POST to `/api/sync` and are added to the server queue.
4. Open Staff to view the queue and Visit Pass, submit symptoms to the Groq-backed intake summary, and use **CALL NEXT**.
5. Open Admin to view PHC totals and history-based trends.

The browser's network status is an online/offline indicator; API failures are shown separately and do not silently mark an offline pass as synced.

## Data and storage

On first run, deterministic, privacy-safe demo data is created at:

- `dataset/phc_queue_history.csv` — 240 queue observations with the prediction inputs.
- `dataset/patient_intake.csv` — 60 synthetic intake rows.

Both files are labeled **SYNTHETIC DEMO DATA** in the UI/data. SQLite is initialized at `instance/namma_phc.sqlite3` and can be overridden with `DATABASE_PATH`. Demo data is not real patient information.

## REST API

- `POST /api/token`
- `GET /api/queue?phc_id=phc-nagercoil`
- `GET /api/visit-pass/<id>`
- `POST /api/symptoms`
- `POST /api/ai/summarize`
- `POST /api/sync`
- `GET /api/dashboard?phc_id=phc-nagercoil`
- `POST /api/staff/call-next`
- `GET /api/health`

The prototype has no staff authentication and should not be deployed with real patient data without appropriate security, privacy, clinical-safety, and operational review.
