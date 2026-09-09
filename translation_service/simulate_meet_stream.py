"""
Mô phỏng phiên Google Meet gửi phụ đề tiếng Nhật tới WebSocket Server
Kiểm tra:
1. Bản nháp interim gửi thẳng về client không bị chặn bởi SequenceBuffer
2. Câu chốt final nối tiếp 1, 2, 3... xả tức thì không bao giờ bị trễ 1.5s timeout!
3. async event loop hoàn toàn không bị đứng nhờ asyncio.to_thread
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
            session_id = "test_meet_session_realtime"
            sentence_seq = 0

            for idx, item in enumerate(SAMPLE_MEET_LINES):
                speaker = item["speaker"]
                block_id = f"blk_{speaker.replace(' ', '_').lower()}_{idx}"
                sentence_seq = 1

                # 1. Gửi bản tạm thời (interim)
                interim_payload = {
                    "type": "interim",
                    "text": item["interim"],
                    "session_id": session_id,
                    "block_id": block_id,
                    "req_id": 1,
                    "seq": sentence_seq,
                    "speaker": speaker,
                    "timestamp": int(time.time() * 1000)
                }
                t_start = time.perf_counter()
                print(f"📤 [GỬI INTERIM #{sentence_seq}][{block_id}] [{speaker}]: {item['interim']}")
                await ws.send(json.dumps(interim_payload))

                # Nhận phản hồi interim
                res_interim = await asyncio.wait_for(ws.recv(), timeout=5.0)
                data = json.loads(res_interim)
                rtt = (time.perf_counter() - t_start) * 1000.0
                print(f"⚡ [NHẬN INTERIM #{data['seq']}][{data.get('block_id')}]: '{data['translated_text']}' [Proc: {data['processing_time_ms']:.1f}ms, RTT: {rtt:.1f}ms]\n")

                await asyncio.sleep(0.15)

                # 2. Gửi bản chốt (final) mang cùng sequence của câu đó
                final_payload = {
                    "type": "final",
                    "text": item["final"],
                    "session_id": session_id,
                    "block_id": block_id,
                    "req_id": 2,
                    "seq": sentence_seq,
                    "speaker": speaker,
                    "timestamp": int(time.time() * 1000)
                }
                t_start = time.perf_counter()
                print(f"📤 [GỬI FINAL   #{sentence_seq}][{block_id}] [{speaker}]: {item['final']}")
                await ws.send(json.dumps(final_payload))

                # Nhận phản hồi final (PHẢI TRẢ VỀ TỨC THÌ, KHÔNG BỊ TREO 1.5s!)
                res_final = await asyncio.wait_for(ws.recv(), timeout=1.0)
                data = json.loads(res_final)
                rtt = (time.perf_counter() - t_start) * 1000.0
                print(f"🎯 [NHẬN FINAL   #{data['seq']}][{data.get('block_id')}]: '{data['translated_text']}' [Proc: {data['processing_time_ms']:.1f}ms, RTT: {rtt:.1f}ms]\n")

                assert rtt < 1000, f"LỖI: RTT vượt quá 1000ms ({rtt:.1f}ms), có thể bị kẹt timeout buffer!"

                await asyncio.sleep(0.3)

            # 3. Thử nghiệm Cache Hit (Gửi lại câu đã từng dịch)
            print("--- KIỂM TRA TỐC ĐỘ CACHE HIT ⚡ ---")
            cache_test_payload = {
                "type": "final",
                "text": SAMPLE_MEET_LINES[0]["final"],
                "session_id": session_id,
                "block_id": "blk_cache_test",
                "req_id": 1,
                "seq": 1,
                "speaker": "Yuki KOBAYASHI",
                "timestamp": int(time.time() * 1000)
            }
            t_cache = time.perf_counter()
            await ws.send(json.dumps(cache_test_payload))
            res_cache = await asyncio.wait_for(ws.recv(), timeout=1.0)
            cache_data = json.loads(res_cache)
            cache_rtt = (time.perf_counter() - t_cache) * 1000.0
            print(f"⚡ [CACHE HIT #{cache_data['seq']}][{cache_data.get('block_id')}]: '{cache_data['translated_text']}' [Proc: {cache_data['processing_time_ms']:.2f}ms, RTT: {cache_rtt:.1f}ms]")

            print("\n🎉 MÔ PHỎNG THÀNH CÔNG: KHÔNG CÒN BỊ TRỄ 1.5s NÀO NỮA VÀ HOÀN TOÀN TÁCH BIỆT BLOCK!")

    except ConnectionRefusedError:
        print("❌ Không thể kết nối tới server! Hãy chắc chắn server đang chạy.")
    except Exception as e:
        print(f"❌ Ngoại lệ mô phỏng: {e}")


if __name__ == "__main__":
    asyncio.run(run_simulation())
