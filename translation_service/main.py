"""
Google Meet JA-VI Translation Service - Main FastAPI Server
Khởi động WebSocket ws://127.0.0.1:8765/ws phục vụ Chrome Extension.
Tích hợp Lifespan nạp model sẵn vào GPU, Cache LRU, và Sequence Buffer.
"""

import time
import asyncio
import json
from contextlib import asynccontextmanager
import sys
import socket
import subprocess
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from translator import TranslationEngine
from cache_manager import TranslationCache
from sequence_buffer import SequenceBufferManager


def ensure_port_available(host: str = "127.0.0.1", port: int = 8765) -> bool:
    """
    Kiểm tra và tự động giải phóng cổng nếu đang bị tiến trình cũ chiếm giữ.
    Giúp phòng ngừa triệt để lỗi Errno 10048 (WSAEADDRINUSE).
    """
    def is_port_in_use() -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return False
            except OSError:
                return True

    if not is_port_in_use():
        return True

    print(f"\n⚠️ CẢNH BÁO: Cổng {host}:{port} đang bị chiếm dụng bởi tiến trình khác!")
    try:
        output = subprocess.check_output("netstat -ano -p tcp", shell=True, text=True)
        target_pid = None
        for line in output.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                if parts:
                    target_pid = int(parts[-1])
                    break

        if target_pid and target_pid != os.getpid():
            print(f"👉 Phát hiện tiến trình cũ đang chiếm cổng (PID: {target_pid}). Đang tự động giải phóng...")
            subprocess.run(f"taskkill /F /PID {target_pid}", shell=True, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(1)
    except Exception as e:
        print(f"[PortManager] Không thể tự động giải phóng PID: {e}")

    if is_port_in_use():
        print(f"❌ LỖI: Cổng {port} vẫn chưa được giải phóng. Vui lòng đóng cửa sổ CMD/Terminal đang chạy server cũ rồi thử lại!\n")
        return False

    print(f"✅ Đã giải phóng thành công cổng {port}!\n")
    return True


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

    # 0. Đảm bảo cổng 8765 sẵn sàng trước khi nạp model (tránh mất thời gian nạp GPU rồi crash)
    if not ensure_port_available(port=8765):
        sys.exit(1)

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
                flushed = await sequence_mgr.check_all_timeout_flushes(current_session_id)
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
            block_id = msg.get("block_id", "default")
            req_id = msg.get("req_id", 0)
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
                # 2. Dịch qua CTranslate2 GPU trong threadpool (KHÔNG CHẶN EVENT LOOP)
                translated_text, inference_ms = await asyncio.to_thread(engine.translate, text)

                # Chỉ lưu cache câu chốt (final), tránh rác cache bởi các câu nháp interim
                if msg_type == "final" and translated_text and not translated_text.startswith("["):
                    cache.set(text, translated_text)

            t_done = time.perf_counter()
            total_proc_ms = (t_done - t_recv) * 1000.0

            # Log chi tiết hiệu năng theo yêu cầu Phần 11 & 17
            hit_str = " (CACHE HIT ⚡)" if is_cache_hit else ""
            print(f"[{msg_type.upper()} #{seq}][Blk: {block_id}][{speaker}] '{text[:35]}...' -> '{translated_text[:35]}...' [Proc: {total_proc_ms:.1f}ms (Infer: {inference_ms:.1f}ms){hit_str}]")

            # 3. Đóng gói kết quả chuẩn định dạng
            result_payload = {
                "type": msg_type,
                "session_id": session_id,
                "block_id": block_id,
                "req_id": req_id,
                "seq": seq,
                "speaker": speaker,
                "original_text": text,
                "translated_text": translated_text,
                "processing_time_ms": total_proc_ms,
                "timestamp": client_ts
            }

            # 4. Gửi trả kết quả
            if msg_type == "interim":
                # Bản nháp interim gửi thẳng về client tức thì không qua hàng đợi
                await websocket.send_text(json.dumps(result_payload, ensure_ascii=False))
            else:
                # Câu chốt final đưa qua Sequence Buffer độc lập của từng Speaker Block
                session_buf = await sequence_mgr.get_or_create(session_id, block_id)
                ready_to_send = await session_buf.add_result(result_payload)
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
    ensure_port_available(host="127.0.0.1", port=8765)
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=False, log_level="info")
