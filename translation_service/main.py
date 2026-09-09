"""
Google Meet JA-VI Translation Service - Main FastAPI Server
Khởi động WebSocket ws://127.0.0.1:8765/ws phục vụ Chrome Extension.
Tích hợp Lifespan nạp model sẵn vào GPU, Cache LRU, và Sequence Buffer.
"""

import time
import asyncio
import json
from contextlib import asynccontextmanager
from typing import Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from translator import TranslationEngine
from cache_manager import TranslationCache
from sequence_buffer import SequenceBufferManager

# Khởi tạo các singleton service
cache = TranslationCache(max_size=10000, cache_file_path="cache/translations.json")
engine = TranslationEngine(model_dir="models/nllb-200-600M-ct2")
sequence_mgr = SequenceBufferManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ================== KHỞI ĐỘNG (STARTUP) ==================
    print("\n=======================================================")
    print("🚀 Đang khởi động Google Meet JA-VI Translation Service...")
    print("=======================================================")

    # 1. Nạp cache đã tích lũy từ trước
    loaded_cache_count = cache.load_from_disk()

    # 2. Nạp model CTranslate2 và Tokenizer lên GPU/CPU ngay từ đầu
    engine_loaded = engine.load_model()
    if not engine_loaded:
        print("⚠️ CẢNH BÁO: Mô hình chưa được nạp. Chạy 'python setup_and_download.py' để tải mô hình NLLB-200!")

    print(f"✅ Sẵn sàng! Thiết bị: {engine.device.upper()} ({engine.compute_type}) | Cache: {loaded_cache_count} mục")
    print("Listening on ws://127.0.0.1:8765/ws\n")

    yield

    # ================== DỪNG (SHUTDOWN) ==================
    print("\n[Shutdown] Đang tắt dịch vụ và lưu bộ đệm cache xuống đĩa...")
    cache.save_to_disk()
    print("[Shutdown] Đã lưu cache an toàn. Tạm biệt!\n")


app = FastAPI(title="Google Meet JA-VI Live Translator", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """
    Kiểm tra trạng thái server, GPU, và cache
    """
    return {
        "status": "online",
        "engine_loaded": engine.is_loaded,
        "device": engine.device,
        "compute_type": engine.compute_type,
        "cache_size": cache.size(),
        "model_dir": engine.model_dir
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_ip = websocket.client.host if websocket.client else "unknown"
    print(f"[WebSocket] Client mới kết nối: {client_ip}")

    # Lên lịch task timeout flush định kỳ cho các buffer
    current_session_id = None

    async def periodic_flush_task():
        while True:
            await asyncio.sleep(0.5)
            if current_session_id:
                session_buf = await sequence_mgr.get_or_create(current_session_id)
                flushed = await session_buf.check_timeout_flush()
                for item in flushed:
                    try:
                        await websocket.send_text(json.dumps(item, ensure_ascii=False))
                    except Exception:
                        break

    flush_worker = asyncio.create_task(periodic_flush_task())

    try:
        while True:
            raw_data = await websocket.receive_text()
            t_recv = time.perf_counter()

            try:
                msg = json.loads(raw_data)
            except json.JSONDecodeError:
                continue

            # Heartbeat ping
            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            # Xử lý yêu cầu dịch
            msg_type = msg.get("type", "final") # "interim" hoặc "final"
            text = msg.get("text", "")
            session_id = msg.get("session_id", "default")
            seq = msg.get("seq", 0)
            speaker = msg.get("speaker", "Người tham gia")
            client_ts = msg.get("timestamp", 0)

            current_session_id = session_id

            if not text.strip():
                continue

            # 1. Kiểm tra Cache trước
            cached_trans = cache.get(text)
            is_cache_hit = False

            if cached_trans is not None:
                is_cache_hit = True
                translated_text = cached_trans
                inference_ms = 0.2
            else:
                # 2. Dịch qua CTranslate2 GPU
                translated_text, inference_ms = engine.translate(text)

                # Chỉ lưu cache câu chốt (final), tránh rác cache bởi các câu nháp interim
                if msg_type == "final" and translated_text and not translated_text.startswith("["):
                    cache.set(text, translated_text)

            t_done = time.perf_counter()
            total_proc_ms = (t_done - t_recv) * 1000.0

            # Log chi tiết hiệu năng theo yêu cầu Phần 11
            hit_str = " (CACHE HIT ⚡)" if is_cache_hit else ""
            print(f"[{msg_type.upper()} #{seq}] [{speaker}] '{text}' -> '{translated_text}' [Proc: {total_proc_ms:.1f}ms (Infer: {inference_ms:.1f}ms){hit_str}]")

            # 3. Đóng gói kết quả chuẩn định dạng Phần 4
            result_payload = {
                "type": msg_type,
                "session_id": session_id,
                "seq": seq,
                "speaker": speaker,
                "original_text": text,
                "translated_text": translated_text,
                "processing_time_ms": total_proc_ms,
                "timestamp": client_ts
            }

            # 4. Đưa qua Sequence Buffer đảm bảo thứ tự
            session_buf = await sequence_mgr.get_or_create(session_id)
            ready_to_send = await session_buf.add_result(result_payload)

            # 5. Gửi ra client
            for ready_item in ready_to_send:
                await websocket.send_text(json.dumps(ready_item, ensure_ascii=False))

    except WebSocketDisconnect:
        print(f"[WebSocket] Client {client_ip} đã ngắt kết nối.")
    except Exception as e:
        print(f"[WebSocket] Ngoại lệ kết nối: {e}")
    finally:
        flush_worker.cancel()
        if current_session_id:
            await sequence_mgr.remove_session(current_session_id)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=False, log_level="info")
