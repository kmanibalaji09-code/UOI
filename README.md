# UOI — Universal Object Identifier
Camera-first web app: Point → Detect → Tap → Identify → Explore.

## Run
    pip install -r backend/requirements.txt
    cp .env.example .env   # optional
    uvicorn backend.main:app --host 0.0.0.0 --port 8000
Open http://localhost:8000 (camera needs HTTPS in production; localhost is fine for dev).
Docker: `docker build -t uoi . && docker run -p 8000:8000 --env-file .env uoi`

## Architecture
- `backend/main.py`: YoloDetector (swap for open-vocabulary later), LensProvider (SerpApi Google Lens) / WikipediaProvider (keyless fallback), `normalize()` result model (title, source, domain, link, thumbnail, description). Frontend only sees normalized data.
- `frontend/`: vanilla JS, state machine (CAMERA_OFF → REQUESTING → ACTIVE → SEARCHING → RESULT_READY → HISTORY), IoU tracker, node-style labels, bottom sheet, detail, discovery, history (localStorage).
- Detection loop runs continuously on a 320px sampled frame; the display feed stays full quality. Search runs only when the user taps an object.

## Notes
- Google Lens needs a publicly reachable crop URL: set `SERPAPI_KEY` and `PUBLIC_BASE_URL` (your deployed HTTPS domain). Without them, results come from Wikipedia by detected label (real links, less precise).
- First detection downloads yolov8n.pt.
- Add periodic cleanup of `backend/crops/` in production.
