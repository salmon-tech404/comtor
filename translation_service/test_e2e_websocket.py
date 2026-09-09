"""
E2E Test: Kiểm tra trực tiếp FastAPI WebSocket Endpoint trong tiến trình
1. Kiểm tra gửi nhận Interim (nhận tức thì không buffer)
2. Kiểm tra gửi nhận Final (đúng block, đúng thứ tự, không delay 1.5s)
3. Kiểm tra Multi-speaker concurrency qua WebSocket
4. Kiểm tra Cache Hit
"""

import sys
import time
import json
from starlette.testclient import TestClient
from main import app, engine, cache

def test_websocket_e2e():
    print("\n=======================================================")
    print(" BẮT ĐẦU TEST E2E WEBSOCKET FASTAPI VỚI TESTCLIENT ")
    print("=======================================================\n")

    # Đảm bảo model đã nạp
    if not engine.is_loaded:
        engine.load_model()

    with TestClient(app) as client:
        with client.websocket_connect("/ws") as websocket:
            print("✅ WebSocket kết nối thành công!")

            # 1. Test Ping Pong
            websocket.send_text(json.dumps({"type": "ping"}))
            pong_res = json.loads(websocket.receive_text())
            assert pong_res.get("type") == "pong", "Ping failed"
            print("✅ Ping/Pong Heartbeat hoạt động hoàn hảo!")

            # 2. Test Multi-Speaker Stream (2 speaker khác nhau)
            # Yuki KOBAYASHI: blk_yuki
            # You: blk_you

            t0 = time.perf_counter()
            websocket.send_text(json.dumps({
                "type": "interim",
                "text": "4件あったので",
                "session_id": "e2e_sess",
                "block_id": "blk_yuki",
                "req_id": 1,
                "seq": 1,
                "speaker": "Yuki KOBAYASHI",
                "timestamp": int(time.time() * 1000)
            }))
            res_interim = json.loads(websocket.receive_text())
            t_interim = (time.perf_counter() - t0) * 1000
            print(f"✅ Interim Blk Yuki received in {t_interim:.1f}ms: '{res_interim['translated_text']}'")
            assert res_interim["block_id"] == "blk_yuki"
            assert res_interim["type"] == "interim"

            # Yuki KOBAYASHI Final
            t0 = time.perf_counter()
            websocket.send_text(json.dumps({
                "type": "final",
                "text": "4件あったので、そこの確認は問題ないです。",
                "session_id": "e2e_sess",
                "block_id": "blk_yuki",
                "req_id": 2,
                "seq": 1,
                "speaker": "Yuki KOBAYASHI",
                "timestamp": int(time.time() * 1000)
            }))
            res_final_yuki = json.loads(websocket.receive_text())
            t_final = (time.perf_counter() - t0) * 1000
            print(f"✅ Final Blk Yuki received in {t_final:.1f}ms: '{res_final_yuki['translated_text']}'")
            assert res_final_yuki["block_id"] == "blk_yuki"
            assert res_final_yuki["type"] == "final"
            assert t_final < 1000, f"Trễ quá 1000ms: {t_final}ms"

            # You Final
            t0 = time.perf_counter()
            websocket.send_text(json.dumps({
                "type": "final",
                "text": "はい、承知いたしました。",
                "session_id": "e2e_sess",
                "block_id": "blk_you",
                "req_id": 1,
                "seq": 1,
                "speaker": "You",
                "timestamp": int(time.time() * 1000)
            }))
            res_final_you = json.loads(websocket.receive_text())
            t_you = (time.perf_counter() - t0) * 1000
            print(f"✅ Final Blk You received in {t_you:.1f}ms: '{res_final_you['translated_text']}'")
            assert res_final_you["block_id"] == "blk_you"
            assert res_final_you["speaker"] == "You"
            assert t_you < 1000, f"Trễ quá 1000ms: {t_you}ms"

            # Cache hit test
            t0 = time.perf_counter()
            websocket.send_text(json.dumps({
                "type": "final",
                "text": "はい、承知いたしました。",
                "session_id": "e2e_sess",
                "block_id": "blk_cache_test",
                "req_id": 1,
                "seq": 1,
                "speaker": "You",
                "timestamp": int(time.time() * 1000)
            }))
            res_cache = json.loads(websocket.receive_text())
            t_cache = (time.perf_counter() - t0) * 1000
            print(f"⚡ Cache Hit received in {t_cache:.2f}ms: '{res_cache['translated_text']}'")
            assert res_cache["processing_time_ms"] < 20, "Cache hit should be super fast!"

    print("\n🎉 TOÀN BỘ CÁC BƯỚC TEST E2E WEBSOCKET ĐỀU THÀNH CÔNG RỰC RỠ!\n")

if __name__ == "__main__":
    test_websocket_e2e()
