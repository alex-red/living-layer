"""
The GPU tracker: follows chosen things through a camera's frames with SAM 2.1's
streaming video predictor, on an NVIDIA GPU.

The lab picks what is followed (a box per thing, from a confirmed outline); this
node only follows. It reads the camera itself (RTSP, or a file for testing), cuts
the camera's crop so its boxes are in the lab's own frame, and streams each
thing's box back. Boxes are shares of the (cropped) frame: {x, y, width, height}.

  GET    /health            open; model, device, memory
  POST   /segment           one image and boxes in, each thing's box out
  PUT    /session           start following: source, crop, things
  POST   /session/things    add or re-anchor things (the session is seeded again)
  PUT    /session/things    replace the set of things, camera kept open
  DELETE /session/things/{id}
  DELETE /session           stop
  GET    /session           state and the last result
  GET    /tracks            the results as server-sent events

Everything but /health takes `Authorization: Bearer $TRACKER_TOKEN`.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field

import av
import av.logging
import numpy as np
import torch
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field
from transformers import Sam2VideoModel, Sam2VideoProcessor

MODEL_ID = os.environ.get("TRACKER_MODEL", "facebook/sam2.1-hiera-small")
TOKEN = os.environ.get("TRACKER_TOKEN", "")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.bfloat16 if DEVICE == "cuda" else torch.float32
# The session's memory grows with every frame; it is seeded again from the
# current boxes after this many.
RESEED_FRAMES = int(os.environ.get("TRACKER_RESEED_FRAMES", "300"))
# A frame is skipped unless around some thing (its box grown by its own size on each
# side) more than this share of pixels changed by more than PIXEL_DELTA, on a 320-wide
# grey copy: the lab's own rule. A share of the whole frame missed a mug being moved,
# about 0.3% of it. A skipped thing is still looked at every STILL_RECHECK_S.
MOTION = float(os.environ.get("TRACKER_MOTION", "0.015"))
PIXEL_DELTA = 24
GREY_WIDTH = 320
STILL_RECHECK_S = 1.0
# A thing whose mask is smaller than this share of the frame counts as not seen.
MIN_AREA = 2e-5

# FFmpeg logs straight to stderr, never through Python: a decoder thread logging a bad
# frame needs the GIL, and a stopped session's reader holds it while freeing that same
# decoder, waiting for its threads. That deadlock froze the whole node (seen with py-spy).
av.logging.restore_default_callback()

if not TOKEN:
    raise SystemExit("TRACKER_TOKEN is not set: the node refuses to run open on the network.")


class Box(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)


class Thing(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    box: Box


class Crop(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class SegmentRequest(BaseModel):
    image: str  # base64 PNG or JPEG
    things: list[Thing] = Field(min_length=1, max_length=32)


class SessionRequest(BaseModel):
    source: str = Field(pattern=r"^(rtsp|rtsps|file)://")
    crop: Crop | None = None
    fps: float = Field(default=10, gt=0, le=30)
    # The motion gate's threshold for this session; 0 runs every frame.
    motion: float = Field(default=MOTION, ge=0)
    things: list[Thing] = Field(default_factory=list, max_length=32)


class ThingsRequest(BaseModel):
    things: list[Thing] = Field(max_length=32)


# --- the model ------------------------------------------------------------------

model = Sam2VideoModel.from_pretrained(MODEL_ID).to(DEVICE, dtype=DTYPE).eval()
processor = Sam2VideoProcessor.from_pretrained(MODEL_ID)
# One model, one GPU: the stateless route and the session take turns.
gpu = threading.Lock()


def corners(box: Box | dict, width: int, height: int) -> list[float]:
    b = box if isinstance(box, dict) else box.model_dump()
    return [
        b["x"] * width,
        b["y"] * height,
        (b["x"] + b["width"]) * width,
        (b["y"] + b["height"]) * height,
    ]


def read_masks(session, output, original_size) -> dict[str, dict]:
    """Each object's box (shares), area (share) and score from one step's output."""
    masks = processor.post_process_masks(
        [output.pred_masks], original_sizes=[original_size], binarize=False
    )[0]
    probs = torch.sigmoid(masks.float())[:, 0]  # (objects, H, W)
    scores = getattr(output, "object_score_logits", None)
    h, w = probs.shape[-2:]
    found: dict[str, dict] = {}
    for i, obj_id in enumerate(session.obj_ids):
        obj_id = session.names[obj_id]
        inside = probs[i] > 0.5
        area = float(inside.sum()) / (h * w)
        score = float(torch.sigmoid(scores[i].float()).max()) if scores is not None else (
            float(probs[i][inside].mean()) if area > 0 else 0.0
        )
        if area < MIN_AREA:
            found[obj_id] = {"seen": False, "score": score, "area": area}
            continue
        rows = torch.nonzero(inside.any(dim=1)).flatten()
        cols = torch.nonzero(inside.any(dim=0)).flatten()
        y0, y1 = int(rows[0]), int(rows[-1]) + 1
        x0, x1 = int(cols[0]), int(cols[-1]) + 1
        found[obj_id] = {
            "seen": score > 0.5,
            "score": round(score, 4),
            "area": round(area, 6),
            "box": {
                "x": x0 / w,
                "y": y0 / h,
                "width": (x1 - x0) / w,
                "height": (y1 - y0) / h,
            },
        }
    return found


def seeded(frame: Image.Image, things: dict[str, dict]):
    """A fresh streaming session with each thing prompted by its box on `frame`."""
    session = processor.init_video_session(inference_device=DEVICE, dtype=DTYPE)
    inputs = processor(images=frame, device=DEVICE, return_tensors="pt")
    size = tuple(int(v) for v in inputs.original_sizes[0])
    ids = list(things)
    # The model numbers objects; the session remembers whose number is whose.
    session.names = {n: thing_id for n, thing_id in enumerate(ids, start=1)}
    w, h = frame.size
    processor.add_inputs_to_inference_session(
        inference_session=session,
        frame_idx=0,
        obj_ids=list(session.names),
        input_boxes=[[corners(things[i], w, h) for i in ids]],
        original_size=size,
    )
    output = model(inference_session=session, frame=inputs.pixel_values[0])
    return session, read_masks(session, output, size)


def step(session, frame: Image.Image):
    inputs = processor(images=frame, device=DEVICE, return_tensors="pt")
    output = model(inference_session=session, frame=inputs.pixel_values[0])
    return read_masks(session, output, tuple(int(v) for v in inputs.original_sizes[0]))


def memory() -> dict:
    if DEVICE != "cuda":
        return {}
    return {
        "allocatedMb": round(torch.cuda.memory_allocated() / 2**20),
        "reservedMb": round(torch.cuda.memory_reserved() / 2**20),
        "peakMb": round(torch.cuda.max_memory_allocated() / 2**20),
    }


# --- reading the camera -----------------------------------------------------------


class Reader(threading.Thread):
    """Keeps only the camera's newest frame; reconnects with backoff."""

    def __init__(self, source: str):
        super().__init__(daemon=True)
        self.source = source
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.frame: av.VideoFrame | None = None
        self.seq = 0
        self.error: str | None = None
        self.size: tuple[int, int] | None = None

    def run(self):
        backoff = 1.0
        while not self.stopped.is_set():
            try:
                self.read()
                backoff = 1.0
            except Exception as e:  # noqa: BLE001 — any camera failure means reconnect
                self.error = f"{type(e).__name__}: {e}"
            if self.stopped.wait(backoff):
                return
            backoff = min(backoff * 2, 15.0)

    def read(self):
        if self.source.startswith("file://"):
            path, options = self.source[len("file://") :], {}
        else:
            path = self.source
            options = {"rtsp_transport": "tcp", "fflags": "nobuffer", "flags": "low_delay", "timeout": "5000000"}
        with av.open(path, options=options, timeout=10) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            pace = 1 / float(stream.average_rate or 10) if self.source.startswith("file://") else 0
            for frame in container.decode(stream):
                if self.stopped.is_set():
                    return
                with self.lock:
                    self.frame = frame
                    self.seq += 1
                self.size = (frame.width, frame.height)
                self.error = None
                if pace:
                    time.sleep(pace)
        if self.source.startswith("file://"):
            raise EOFError("end of file, playing again")

    def latest(self) -> tuple[int, av.VideoFrame | None]:
        with self.lock:
            return self.seq, self.frame


# --- following ----------------------------------------------------------------------


@dataclass
class Session:
    request: SessionRequest
    reader: Reader
    things: dict[str, dict] = field(default_factory=dict)  # id -> last box
    pending: bool = True  # seed again on the next frame
    stopped: threading.Event = field(default_factory=threading.Event)
    last: dict | None = None
    frames: int = 0
    skipped: int = 0
    started: float = field(default_factory=time.time)
    error: str | None = None


class Hub:
    """Fans results out to the /tracks listeners."""

    def __init__(self):
        self.queues: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def publish(self, event: dict):
        if not self.loop:
            return
        for q in list(self.queues):
            self.loop.call_soon_threadsafe(self.offer, q, event)

    @staticmethod
    def offer(q: asyncio.Queue, event: dict):
        if q.full():
            q.get_nowait()  # a slow listener gets the newest
        q.put_nowait(event)


hub = Hub()
current: Session | None = None
current_lock = threading.Lock()


def cropped(frame: av.VideoFrame, crop: Crop | None) -> Image.Image:
    picture = frame.to_ndarray(format="rgb24")
    if crop:
        h, w = picture.shape[:2]
        x0, y0 = round(crop.x * w), round(crop.y * h)
        picture = picture[y0 : y0 + max(1, round(crop.h * h)), x0 : x0 + max(1, round(crop.w * w))]
    return Image.fromarray(np.ascontiguousarray(picture))


def grey(picture: Image.Image) -> np.ndarray:
    w, h = picture.size
    size = (GREY_WIDTH, max(2, round(GREY_WIDTH * h / w)))
    return np.asarray(picture.convert("L").resize(size, Image.BILINEAR), dtype=np.int16)


def motion_around(before: np.ndarray, now: np.ndarray, boxes: list[dict]) -> float:
    """The most changed share of pixels around any of the boxes (each grown by its own size)."""
    h, w = now.shape
    most = 0.0
    for b in boxes:
        x0 = max(0, int((b["x"] - b["width"]) * w))
        y0 = max(0, int((b["y"] - b["height"]) * h))
        x1 = min(w, int((b["x"] + 2 * b["width"]) * w) + 1)
        y1 = min(h, int((b["y"] + 2 * b["height"]) * h) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        changed = np.abs(now[y0:y1, x0:x1] - before[y0:y1, x0:x1]) > PIXEL_DELTA
        most = max(most, float(changed.mean()))
    return most


def follow(s: Session):
    tracker = None
    last_seq = 0
    last_grey: np.ndarray | None = None
    last_run = 0.0
    since_seed = 0
    interval = 1 / s.request.fps
    reported = None
    while not s.stopped.is_set():
        tick = time.monotonic()
        seq, frame = s.reader.latest()
        # A camera that can't be read is said once each time its error changes, so the lab can show why.
        if s.reader.error != reported:
            reported = s.reader.error
            if reported:
                hub.publish({"type": "error", "error": f"camera: {redact(reported)}", "at": time.time()})
        if frame is None or seq == last_seq:
            s.stopped.wait(0.02)
            continue
        last_seq = seq
        try:
            picture = cropped(frame, s.request.crop)
            small = grey(picture)
            with current_lock:
                things = dict(s.things)
                reseed = s.pending or since_seed >= RESEED_FRAMES
                s.pending = False
            fits = last_grey is not None and last_grey.shape == small.shape
            motion = motion_around(last_grey, small, list(things.values())) if fits else 1.0
            if not things:
                tracker = None
            elif reseed or tracker is None or motion >= s.request.motion or tick - last_run >= STILL_RECHECK_S:
                t0 = time.perf_counter()
                with gpu:
                    if reseed or tracker is None:
                        tracker, found = seeded(picture, things)
                        since_seed = 0
                    else:
                        found = step(tracker, picture)
                        since_seed += 1
                ms = (time.perf_counter() - t0) * 1000
                last_grey, last_run = small, tick
                with current_lock:
                    for thing_id, seen in found.items():
                        if seen.get("seen") and thing_id in s.things:
                            s.things[thing_id] = seen["box"]
                s.frames += 1
                event = {
                    "type": "tracks",
                    "seq": seq,
                    "at": time.time(),
                    "ms": round(ms, 1),
                    "motion": round(motion, 4),
                    "seeded": since_seed == 0,
                    "size": list(picture.size),
                    "things": [{"id": k, **v} for k, v in found.items()],
                }
                s.last = event
                hub.publish(event)
            else:
                s.skipped += 1
            s.error = None
        except Exception as e:  # noqa: BLE001 — report, seed again, keep following
            s.error = f"{type(e).__name__}: {e}"
            tracker = None
            hub.publish({"type": "error", "error": s.error, "at": time.time()})
            s.stopped.wait(1.0)
        s.stopped.wait(max(0.0, interval - (time.monotonic() - tick)))


def redact(text: str) -> str:
    """A camera URL's password left out of what is sent back."""
    return re.sub(r"//[^/@\s]+@", "//***@", text)


def stop_current():
    global current
    with current_lock:
        s, current = current, None
    if s:
        s.stopped.set()
        s.reader.stopped.set()
        if DEVICE == "cuda":
            torch.cuda.empty_cache()


# --- routes ---------------------------------------------------------------------------

app = FastAPI(title="Living Layer GPU tracker")


@app.on_event("startup")
async def startup():
    hub.loop = asyncio.get_running_loop()


def authorised(request: Request):
    if request.headers.get("authorization") != f"Bearer {TOKEN}":
        raise HTTPException(401, "a bearer token is required")


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_ID,
        "device": torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu",
        "dtype": str(DTYPE).removeprefix("torch."),
        "following": current is not None,
        "memory": memory(),
    }


@app.post("/segment", dependencies=[Depends(authorised)])
def segment(body: SegmentRequest):
    try:
        picture = Image.open(io.BytesIO(base64.b64decode(body.image))).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"not an image: {e}") from e
    if len({t.id for t in body.things}) != len(body.things):
        raise HTTPException(400, "thing ids must be distinct")
    t0 = time.perf_counter()
    with gpu:
        _, found = seeded(picture, {t.id: t.box.model_dump() for t in body.things})
    return {
        "ms": round((time.perf_counter() - t0) * 1000, 1),
        "size": list(picture.size),
        "things": [{"id": k, **v} for k, v in found.items()],
        "memory": memory(),
    }


@app.put("/session", dependencies=[Depends(authorised)])
def start(body: SessionRequest):
    global current
    stop_current()
    reader = Reader(body.source)
    s = Session(request=body, reader=reader, things={t.id: t.box.model_dump() for t in body.things})
    with current_lock:
        current = s
    reader.start()
    threading.Thread(target=follow, args=(s,), daemon=True).start()
    return state()


@app.post("/session/things", dependencies=[Depends(authorised)])
def add(body: ThingsRequest):
    with current_lock:
        if not current:
            raise HTTPException(409, "not following: PUT /session first")
        for t in body.things:
            current.things[t.id] = t.box.model_dump()
        current.pending = True
    return state()


@app.put("/session/things", dependencies=[Depends(authorised)])
def replace(body: ThingsRequest):
    """The whole set of things, keeping the camera open: what the lab follows now."""
    with current_lock:
        if not current:
            raise HTTPException(409, "not following: PUT /session first")
        things = {t.id: t.box.model_dump() for t in body.things}
        # The same things: keep following them where they are, without seeding again.
        if things.keys() != current.things.keys():
            current.things = things
            current.pending = True
    return state()


@app.delete("/session/things/{thing_id}", dependencies=[Depends(authorised)])
def forget(thing_id: str):
    with current_lock:
        if not current or thing_id not in current.things:
            raise HTTPException(404, "no such thing")
        del current.things[thing_id]
        current.pending = True
    return state()


@app.delete("/session", dependencies=[Depends(authorised)])
def stop():
    stop_current()
    return {"following": False}


@app.get("/session", dependencies=[Depends(authorised)])
def state():
    s = current
    if not s:
        return {"following": False, "memory": memory()}
    up = time.time() - s.started
    return {
        "following": True,
        "source": s.request.source.split("@")[-1],  # no credentials back
        "crop": s.request.crop,
        "fps": s.request.fps,
        "things": s.things,
        "frames": s.frames,
        "skipped": s.skipped,
        "cameraRate": round(s.reader.seq / up, 2) if up > 0 else 0,
        "rate": round(s.frames / up, 2) if up > 0 else 0,
        "camera": {"size": s.reader.size, "error": s.reader.error and redact(s.reader.error)},
        "error": s.error,
        "last": s.last,
        "memory": memory(),
    }


@app.get("/tracks", dependencies=[Depends(authorised)])
async def tracks():
    q: asyncio.Queue = asyncio.Queue(maxsize=4)
    hub.queues.add(q)
    # A camera already failing is said at once: its error was sent before this listener came.
    s = current
    if s and s.reader.error:
        q.put_nowait({"type": "error", "error": f"camera: {redact(s.reader.error)}", "at": time.time()})

    async def events():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": idle\n\n"
        finally:
            hub.queues.discard(q)

    return StreamingResponse(events(), media_type="text/event-stream")
