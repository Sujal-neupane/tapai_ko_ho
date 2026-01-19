from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

app = FastAPI(title="Cyber Guardian AI Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

QUEUE_REDIS_URL = os.getenv("INFERENCE_QUEUE_URL") or os.getenv("REDIS_URL")
QUEUE_KEY = "inference:jobs"
RESULT_PREFIX = "inference:result:"
QUEUE_TIMEOUT = float(os.getenv("INFERENCE_QUEUE_TIMEOUT", "1.0"))

redis_client: Optional[Redis] = None
if QUEUE_REDIS_URL:
        redis_client = Redis.from_url(QUEUE_REDIS_URL, decode_responses=True)


async def _analyze_via_queue(frame_b64: str, sent_at_ms: float) -> Optional[dict[str, Any]]:
    if not redis_client:
        return None
    job_id = secrets.token_hex(8)
    try:
        await redis_client.lpush(QUEUE_KEY, json.dumps({"id": job_id, "frame": frame_b64, "sent_at": sent_at_ms}))
        res = await redis_client.brpop(f"{RESULT_PREFIX}{job_id}", timeout=QUEUE_TIMEOUT)
        if not res:
            return None
        _, data = res
        return json.loads(data)
    except Exception as exc:  # queue issues should not break websocket
        print(f"queue error: {exc}")
        return None


def _analyze_frame(frame_b64: str, sent_at_ms: float) -> dict[str, object]:
    now_ms = time.time() * 1000
    replay = now_ms - sent_at_ms > 2000
    # Basic stub heuristic: longer payloads + randomness => confidence.
    payload = frame_b64.split(",")[-1]
    try:
        decoded = base64.b64decode(payload, validate=True)
    except Exception:
        return {
            "is_fake": True,
            "confidence": 0.99,
            "alert_msg": "Invalid frame encoding",
        }

    entropy_hint = min(len(set(decoded[:512])), 64) / 64
    noise = secrets.randbelow(20) / 100
    confidence = min(0.5 + entropy_hint + noise, 0.99)

    if replay:
        return {
          "is_fake": True,
          "confidence": max(confidence, 0.85),
          "alert_msg": "Potential Replay Attack: frame older than 2s",
        }

    is_fake = confidence > 0.75
    alert = "Anomaly detected" if is_fake else "Frame appears authentic"
    return {
        "is_fake": is_fake,
        "confidence": round(confidence, 3),
        "alert_msg": alert,
    }


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_text()
            try:
                payload = json.loads(data)
                frame = payload.get("frame")
                sent_at = float(payload.get("sent_at", 0))
            except (ValueError, TypeError):
                await ws.send_json({"is_fake": True, "confidence": 0.99, "alert_msg": "Bad payload"})
                continue

            # Prefer external inference queue; fall back to local heuristic.
            result = await _analyze_via_queue(frame or "", sent_at)
            if result is None:
                result = _analyze_frame(frame or "", sent_at)
            result["timestamp"] = datetime.now(timezone.utc).isoformat()
            await ws.send_json(result)
            await asyncio.sleep(0)
    except WebSocketDisconnect:
        return


# Conference room state: meetingId -> dict of peerId -> websocket
conference_rooms: dict[str, dict[str, WebSocket]] = {}


@app.websocket("/conference")
async def conference_endpoint(ws: WebSocket):
    await ws.accept()
    meeting_id: str | None = None
    peer_id: str = secrets.token_hex(4)
    
    try:
        while True:
            data = await ws.receive_text()
            try:
                payload = json.loads(data)
                msg_type = payload.get("type")

                if msg_type == "join":
                    meeting_id = payload.get("meetingId")
                    if not meeting_id:
                        await ws.send_json({"type": "error", "message": "Meeting ID required"})
                        continue

                    if meeting_id not in conference_rooms:
                        conference_rooms[meeting_id] = {}
                    
                    # Get existing peers before adding new one
                    existing_peers = list(conference_rooms[meeting_id].keys())
                    
                    # Add new peer
                    conference_rooms[meeting_id][peer_id] = ws

                    # Send joined confirmation with peer list
                    await ws.send_json({
                        "type": "joined",
                        "peerId": peer_id,
                        "existingPeers": existing_peers,
                        "participantCount": len(conference_rooms[meeting_id]),
                    })

                    # Notify all existing peers about new participant
                    for other_peer_id, peer_ws in conference_rooms[meeting_id].items():
                        if other_peer_id != peer_id:
                            await peer_ws.send_json({
                                "type": "peer-joined",
                                "peerId": peer_id,
                                "participantCount": len(conference_rooms[meeting_id]),
                            })

                elif msg_type in ("offer", "answer", "ice-candidate"):
                    target_peer_id = payload.get("targetPeerId")
                    meeting_id = payload.get("meetingId")
                    
                    if not meeting_id or meeting_id not in conference_rooms:
                        continue

                    # If target specified, send only to that peer
                    if target_peer_id and target_peer_id in conference_rooms[meeting_id]:
                        payload["fromPeerId"] = peer_id
                        await conference_rooms[meeting_id][target_peer_id].send_json(payload)
                    else:
                        # Broadcast to all peers except sender
                        for other_peer_id, peer_ws in conference_rooms[meeting_id].items():
                            if other_peer_id != peer_id:
                                payload["fromPeerId"] = peer_id
                                await peer_ws.send_json(payload)

            except (ValueError, TypeError):
                await ws.send_json({"type": "error", "message": "Invalid payload"})
                continue

    except WebSocketDisconnect:
        if meeting_id and meeting_id in conference_rooms:
            if peer_id in conference_rooms[meeting_id]:
                del conference_rooms[meeting_id][peer_id]
            # Notify remaining peers that someone left
            for other_peer_id, peer_ws in conference_rooms.get(meeting_id, {}).items():
                try:
                    await peer_ws.send_json({
                        "type": "peer-left",
                        "peerId": peer_id,
                        "participantCount": len(conference_rooms.get(meeting_id, {})),
                    })
                except:
                    pass
            if not conference_rooms.get(meeting_id):
                del conference_rooms[meeting_id]
        return


# API endpoint to check room status
@app.get("/api/room/{meeting_id}")
async def get_room_info(meeting_id: str):
    if meeting_id in conference_rooms:
        return {
            "exists": True,
            "participantCount": len(conference_rooms[meeting_id]),
            "maxParticipants": 10,
        }
    return {"exists": False, "participantCount": 0, "maxParticipants": 10}
