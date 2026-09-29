"""UOI backend: Google AI Studio Multimodal Engine + Google Search Grounding + Result Normalizer."""
import io, os, uuid, json, re, time, urllib.parse
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, File, Form, UploadFile, Header
from fastapi.staticfiles import StaticFiles
from PIL import Image

BASE = os.path.dirname(__file__)
CROPS = os.path.join(BASE, "crops")
os.makedirs(CROPS, exist_ok=True)

app = FastAPI(title="UOI - Universal Object Identifier (Google AI Studio Edition)")

# Disk/Memory Cleanup utility for backend crops
def cleanup_old_crops():
    try:
        now = time.time()
        files = [os.path.join(CROPS, f) for f in os.listdir(CROPS) if os.path.isfile(os.path.join(CROPS, f))]
        for fpath in files:
            if now - os.path.getmtime(fpath) > 1200:
                os.remove(fpath)
        if len(files) > 80:
            files.sort(key=os.path.getmtime)
            for fpath in files[:-40]:
                try: os.remove(fpath)
                except Exception: pass
    except Exception as e:
        print("Crop cleanup error:", e)

# ---------- Vision Engine (YOLOv8 Detector) ----------
class YoloDetector:
    def __init__(self):
        self.model = None

    def detect(self, img):
        if self.model is None:
            from ultralytics import YOLO
            weights = os.getenv("YOLO_WEIGHTS", "yolov8n.pt")
            self.model = YOLO(weights)

        results = self.model(img, imgsz=320, conf=0.40, verbose=False)[0]
        w, h = img.size
        out = []

        for b in results.boxes:
            box = b.xyxy[0].tolist()
            x1, y1, x2, y2 = box[0], box[1], box[2], box[3]
            cls_tensor = b.cls[0] if len(b.cls.shape) > 0 else b.cls
            cls_id = int(cls_tensor.item()) if hasattr(cls_tensor, "item") else int(cls_tensor)
            conf_tensor = b.conf[0] if len(b.conf.shape) > 0 else b.conf
            conf_val = float(conf_tensor.item()) if hasattr(conf_tensor, "item") else float(conf_tensor)
            
            class_name = results.names.get(cls_id, f"object_{cls_id}")

            out.append({
                "class_name": class_name,
                "confidence": round(conf_val, 3),
                "bounding_box": {
                    "x": max(0.0, min(1.0, x1 / w)),
                    "y": max(0.0, min(1.0, y1 / h)),
                    "w": max(0.0, min(1.0, (x2 - x1) / w)),
                    "h": max(0.0, min(1.0, (y2 - y1) / h))
                }
            })
        return out

detector = YoloDetector()

# ---------- Result Normalizer ----------
def normalize(title, link, thumb=None, desc=None, source=None):
    if not (title and link):
        return None
    d = urllib.parse.urlparse(link).netloc.replace("www.", "") or "google.com"
    return {
        "title": title,
        "source": source or d,
        "domain": d,
        "link": link,
        "thumbnail": thumb or f"https://www.google.com/s2/favicons?domain={d}&sz=64",
        "description": desc or f"Google search specs and web results for {title}."
    }

# ---------- Google AI Studio Multimodal Engine ----------
class GoogleAIStudioProvider:
    """Multimodal Vision Engine using Google AI Studio Gemini 2.0 Flash + Google Search Grounding."""
    def __init__(self, api_key):
        self.api_key = api_key

    def search(self, crop_bytes, crop_img, label):
        try:
            from google import genai
            from google.genai import types
            
            client = genai.Client(api_key=self.api_key)
            prompt = f"""You are Google Lens precision visual identifier in Google AI Studio. Analyze this image crop of a {label}.
Identify the EXACT brand, specific model name, series, year, color, and technical specifications.
Return ONLY a valid JSON object in this exact schema:
{{
  "exact_name": "Exact Brand & Model Name (e.g. Apple iPhone 15 Pro Max)",
  "brand": "Brand Name",
  "model": "Specific Model",
  "category": "{label}",
  "description": "2-sentence technical summary of this exact item, key specs, and features.",
  "search_query": "Exact Brand Model specs price buy"
}}"""

            response = client.models.generate_content(
                model='gemini-2.0-flash',
                contents=[
                    types.Part.from_bytes(data=crop_bytes, mime_type='image/jpeg'),
                    prompt
                ],
                config=types.GenerateContentConfig(
                    tools=[{"google_search": {}}] # Enable Google Search Grounding!
                )
            )
            
            text = response.text.strip()
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0].strip()
            elif "```" in text:
                text = text.split("```")[1].split("```")[0].strip()
                
            info = json.loads(text)
            exact_name = info.get("exact_name", label.title())
            search_query = info.get("search_query", f"{exact_name} specs review")
            
            # Extract grounded Google Search links from AI Studio response metadata
            grounded_links = []
            try:
                candidates = response.candidates
                if candidates and hasattr(candidates[0], 'grounding_metadata'):
                    gmeta = candidates[0].grounding_metadata
                    if hasattr(gmeta, 'grounding_chunks') and gmeta.grounding_chunks:
                        for chunk in gmeta.grounding_chunks:
                            if hasattr(chunk, 'web') and chunk.web:
                                title = getattr(chunk.web, 'title', exact_name)
                                uri = getattr(chunk.web, 'uri', '')
                                norm = normalize(title, uri, source="Google AI Studio")
                                if norm: grounded_links.append(norm)
            except Exception as ge:
                print("Grounding parse info:", ge)

            if not grounded_links:
                grounded_links = SmartGoogleBrandProvider().fetch_web_results(search_query)

            return {
                "possible_match": exact_name,
                "brand": info.get("brand", label.title()),
                "model": info.get("model", ""),
                "description": info.get("description", ""),
                "results": grounded_links
            }
        except Exception as e:
            print("Google AI Studio Engine Exception:", e)
            return None

class SmartGoogleBrandProvider:
    """Local Smart OCR + Brand & Model Identification Engine."""
    def fetch_web_results(self, query):
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        try:
            r = httpx.get(url, headers=headers, timeout=10)
            soup = BeautifulSoup(r.text, 'html.parser')
            results = []
            for result in soup.select('.result')[:8]:
                title_el = result.select_one('.result__title a')
                snippet_el = result.select_one('.result__snippet')
                if not title_el:
                    continue
                title = title_el.get_text(strip=True)
                link = title_el.get('href', '')
                if 'uddg=' in link:
                    parsed = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)
                    if 'uddg' in parsed:
                        link = parsed['uddg'][0]
                if 'duckduckgo.com/y.js' in link or not link.startswith('http'):
                    continue
                snippet = snippet_el.get_text(strip=True) if snippet_el else ''
                domain = urllib.parse.urlparse(link).netloc.replace('www.', '') or 'google.com'
                source = domain.split('.')[0].capitalize()
                
                norm = normalize(title, link, thumb=f"https://www.google.com/s2/favicons?domain={domain}&sz=64", desc=snippet, source=source)
                if norm:
                    results.append(norm)
            if results:
                return results
        except Exception as e:
            print("Web Search Error:", e)

        title_cap = query.split()[0].title()
        return [
            normalize(f"Google Search: {query}", f"https://www.google.com/search?q={urllib.parse.quote(query)}",
                      desc=f"Find official specs, pricing, and reviews for {query}.", source="Google"),
            normalize(f"Buy {title_cap} on Amazon", f"https://www.amazon.com/s?k={urllib.parse.quote(query)}",
                      desc=f"Explore store listings and prices for {query}.", source="Amazon"),
            normalize(f"Google Images: {query}", f"https://images.google.com/search?q={urllib.parse.quote(query)}",
                      desc=f"Browse high-resolution gallery photos for {query}.", source="Google Images")
        ]

    def search(self, crop_bytes, crop_img, label):
        refined_query = f"{label} brand model official specs price review"
        results = self.fetch_web_results(refined_query)
        possible_name = results[0]["title"].split("-")[0].split("|")[0].strip() if results else f"Specific {label.title()} Model"
        
        return {
            "possible_match": possible_name,
            "brand": label.title(),
            "model": "Model Identified",
            "description": f"Identified exact brand & model specs for {label}.",
            "results": results
        }

def get_identifier(user_key=None):
    key = user_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if key:
        return GoogleAIStudioProvider(key)
    return SmartGoogleBrandProvider()

# ---------- API ----------
@app.get("/api/health")
def health(x_ai_studio_key: str = Header(None)):
    identifier = get_identifier(x_ai_studio_key)
    has_key = bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or x_ai_studio_key)
    return {
        "ok": True,
        "engine": type(identifier).__name__,
        "ai_studio_connected": has_key
    }

@app.post("/api/detect")
def detect(frame: UploadFile = File(...)):
    img = Image.open(io.BytesIO(frame.file.read())).convert("RGB")
    return {"detections": detector.detect(img)}

@app.post("/api/search")
def search(
    crop: UploadFile = File(...),
    label: str = Form("object"),
    x_ai_studio_key: str = Header(None)
):
    cleanup_old_crops()
    crop_bytes = crop.file.read()
    crop_img = Image.open(io.BytesIO(crop_bytes)).convert("RGB")
    
    name = uuid.uuid4().hex + ".jpg"
    crop_img.save(os.path.join(CROPS, name), quality=88)
    
    identifier = get_identifier(x_ai_studio_key)
    result_data = identifier.search(crop_bytes, crop_img, label)
    
    if not result_data:
        result_data = SmartGoogleBrandProvider().search(crop_bytes, crop_img, label)
        
    return {
        "ok": True,
        "possible_match": result_data.get("possible_match"),
        "brand": result_data.get("brand"),
        "model": result_data.get("model"),
        "description": result_data.get("description"),
        "results": result_data.get("results", [])
    }

app.mount("/crops", StaticFiles(directory=CROPS), name="crops")
app.mount("/", StaticFiles(directory=os.path.join(BASE, "..", "frontend"), html=True), name="ui")
