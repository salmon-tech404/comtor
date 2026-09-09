"""
Mô phỏng phiên Google Meet gửi phụ đề tiếng Nhật tới WebSocket Server
Sử dụng các câu thoại thực tế từ chính ảnh chụp cuộc họp của bạn!
"""

import asyncio
import json
import time

WS_URL = "ws://127.0.0.1:8765/ws"

SAMPLE_MEET_LINES = [
    {
        "speaker": "Yuki KOBAYASHI",
        "interim": "4件あったので、そこの確認は",
        "final": "4件あったので、そこの確認は問題ないです。ここね この4kは問題なしです。"
    },
    {
        "speaker": "You",
        "interim": "はい、といたしました。",
        "final": "はい、といたしました。リアリティエンジェルいたしました。はい。"
    },
    {
        "speaker": "Yuki KOBAYASHI",
        "interim": "はい。なのでそこも抜きますと。",
        "final": "はい。なのでそこも抜きますと。残ったこの3件をすいません。今日確認したいです。"
    }
]


async def run_simulation():
    try:
        import websockets
    except ImportError:
        print("❌ Cần cài đặt thư viện websockets: pip install websockets")
        return

    print(f"Đang kết nối tới WebSocket: {WS_URL}...")
    try:
        async with websockets.connect(WS_URL) as ws:
            print("✅ Kết nối WebSocket thành công!\n")
            session_id = "test_meet_session_001"
            seq = 0

            for item in SAMPLE_MEET_LINES:
                speaker = item["speaker"]

                # 1. Gửi bản tạm thời (interim)
                seq += 1
                interim_payload = {
                    "type": "interim",
                    "text": item["interim"],
                    "session_id": session_id,
                    "seq": seq,
                    "speaker": speaker,
                    "timestamp": int(time.time() * 1000)
                }
                print(f"📤 [GỬI INTERIM #{seq}] [{speaker}]: {item['interim']}")
                await ws.send(json.dumps(interim_payload))

                # Nhận phản hồi interim
                res_interim = await asyncio.wait_for(ws.recv(), timeout=5.0)
                data = json.loads(res_interim)
                print(f"📥 [NHẬN INTERIM #{data['seq']}]: '{data['translated_text']}' ({data['processing_time_ms']:.1f}ms)\n")

                await asyncio.sleep(0.3)

                # 2. Gửi bản chốt (final)
                seq += 1
                final_payload = {
                    "type": "final",
                    "text": item["final"],
                    "session_id": session_id,
                    "seq": seq,
                    "speaker": speaker,
                    "timestamp": int(time.time() * 1000)
                }
                print(f"📤 [GỬI FINAL   #{seq}] [{speaker}]: {item['final']}")
                await ws.send(json.dumps(final_payload))

                # Nhận phản hồi final
                res_final = await asyncio.wait_for(ws.recv(), timeout=5.0)
                data = json.loads(res_final)
                print(f"📥 [NHẬN FINAL   #{data['seq']}]: '{data['translated_text']}' ({data['processing_time_ms']:.1f}ms)\n")

                await asyncio.sleep(0.5)

            # 3. Thử nghiệm Cache Hit (Gửi lại câu đã từng dịch)
            print("--- KIỂM TRA TỐC ĐỘ CACHE HIT ⚡ ---")
            seq += 1
            cache_test_payload = {
                "type": "final",
                "text": SAMPLE_MEET_LINES[0]["final"],
                "session_id": session_id,
                "seq": seq,
                "speaker": "Yuki KOBAYASHI",
                "timestamp": int(time.time() * 1000)
            }
            await ws.send(json.dumps(cache_test_payload))
            res_cache = await asyncio.wait_for(ws.recv(), timeout=2.0)
            cache_data = json.loads(res_cache)
            print(f"⚡ [CACHE HIT #{cache_data['seq']}]: '{cache_data['translated_text']}' ({cache_data['processing_time_ms']:.2f}ms)")

            print("\n🎉 Mô phỏng hoàn tất thành công 100%!")

    except ConnectionRefusedError:
        print("❌ Không thể kết nối tới server! Hãy chắc chắn bạn đã khởi động 'python main.py'.")
    except Exception as e:
        print(f"❌ Ngoại lệ mô phỏng: {e}")


if __name__ == "__main__":
    asyncio.run(run_simulation())
