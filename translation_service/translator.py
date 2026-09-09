"""
Translator Engine - Quản lý CTranslate2 và Tokenizer NLLB-200.
Tự động kích hoạt GPU CUDA (RTX 4060) với compute_type='float16' hoặc fallback sang CPU int8.
"""

import os
import time
from typing import Tuple, List, Optional

try:
    import ctranslate2
    from transformers import AutoTokenizer
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False


class TranslationEngine:
    def __init__(self, model_dir: str = "models/nllb-200-600M-ct2", tokenizer_name: str = "facebook/nllb-200-distilled-600M"):
        self.model_dir = model_dir
        self.tokenizer_name = tokenizer_name
        self.translator: Optional[ctranslate2.Translator] = None
        self.tokenizer = None
        self.device = "cpu"
        self.compute_type = "int8"
        self.is_loaded = False

    def detect_device(self) -> Tuple[str, str]:
        """
        Tự động kiểm tra khả năng hỗ trợ CUDA của CTranslate2 và GPU
        """
        if not HAS_DEPS:
            return "cpu", "int8"

        try:
            cuda_count = ctranslate2.get_cuda_device_count()
            if cuda_count > 0:
                print(f"[Engine] Phát hiện {cuda_count} thiết bị NVIDIA GPU hỗ trợ CUDA!")
                return "cuda", "float16"
        except Exception as e:
            print(f"[Engine] Không thể truy vấn CUDA, sử dụng CPU: {e}")

        return "cpu", "int8"

    def load_model(self) -> bool:
        """
        Khởi tạo và nạp model CTranslate2 cùng Tokenizer vào bộ nhớ ngay khi service khởi động
        """
        if not HAS_DEPS:
            print("[Engine] Thiếu thư viện ctranslate2 hoặc transformers. Vui lòng cài đặt requirements.txt!")
            return False

        if not os.path.exists(self.model_dir):
            print(f"[Engine] Thư mục mô hình {self.model_dir} chưa tồn tại!")
            print("[Engine] Vui lòng chạy setup_and_download.py để tải mô hình NLLB-200 về.")
            return False

        self.device, self.compute_type = self.detect_device()
        print(f"[Engine] Đang nạp mô hình từ '{self.model_dir}' lên {self.device.upper()} ({self.compute_type})...")

        start_time = time.time()
        try:
            # 1. Nạp bộ suy luận CTranslate2
            self.translator = ctranslate2.Translator(
                self.model_dir,
                device=self.device,
                compute_type=self.compute_type,
                inter_threads=2,
                intra_threads=4
            )

            # 2. Nạp Tokenizer NLLB-200 (Hỗ trợ SentencePiece của NLLB)
            # Thử nạp từ model_dir nếu có tokenizer files kèm theo, nếu không nạp từ Hugging Face
            try:
                self.tokenizer = AutoTokenizer.from_pretrained(self.model_dir, src_lang="jpn_Jpan")
            except Exception:
                print(f"[Engine] Nạp tokenizer từ HuggingFace '{self.tokenizer_name}'...")
                self.tokenizer = AutoTokenizer.from_pretrained(self.tokenizer_name, src_lang="jpn_Jpan")

            load_time = time.time() - start_time
            print(f"[Engine] Nạp mô hình thành công trong {load_time:.2f}s! Sẵn sàng dịch tức thì.")
            self.is_loaded = True
            return True
        except Exception as e:
            print(f"[Engine] Lỗi nghiêm trọng khi nạp mô hình: {e}")
            self.is_loaded = False
            return False

    def translate(self, text: str, src_lang: str = "jpn_Jpan", tgt_lang: str = "vie_Latn") -> Tuple[str, float]:
        """
        Thực thi dịch thuật từ tiếng Nhật sang tiếng Việt:
        - Tokenize input với mã ngôn ngữ jpn_Jpan
        - ctranslate2.translate_batch với target_prefix=[[vie_Latn]]
        - Decode output token thành chuỗi tiếng Việt hoàn chỉnh
        Trả về: (bản dịch tiếng Việt, thời gian xử lý ms)
        """
        if not text or not text.strip():
            return "", 0.0

        if not self.is_loaded or not self.translator or not self.tokenizer:
            # Chế độ dự phòng khi chưa tải xong model để test pipeline
            return f"[Chưa tải model] {text}", 1.0

        t0 = time.perf_counter()

        try:
            self.tokenizer.src_lang = src_lang
            # 1. Tokenize văn bản nguồn
            source_tokens = self.tokenizer.convert_ids_to_tokens(self.tokenizer.encode(text.strip()))

            # 2. Định dạng target_prefix cho NLLB
            target_prefix = [[tgt_lang]]

            # 3. Suy luận song song qua CTranslate2
            results = self.translator.translate_batch(
                [source_tokens],
                target_prefix=target_prefix,
                beam_size=1, # Beam size 1 cực nhanh cho real-time
                max_decoding_length=128,
                sampling_temperature=1.0
            )

            # 4. Trích xuất token kết quả
            output_tokens = results[0].hypotheses[0]

            # Bỏ token ngôn ngữ đích nếu nằm ở đầu (ví dụ: 'vie_Latn')
            if output_tokens and output_tokens[0] == tgt_lang:
                output_tokens = output_tokens[1:]

            # 5. Giải mã ngược về văn bản tiếng Việt
            translated_text = self.tokenizer.decode(
                self.tokenizer.convert_tokens_to_ids(output_tokens),
                skip_special_tokens=True
            ).strip()

            t1 = time.perf_counter()
            inference_ms = (t1 - t0) * 1000.0
            return translated_text, inference_ms

        except Exception as e:
            print(f"[Engine] Lỗi trong quá trình dịch: {e}")
            t1 = time.perf_counter()
            return f"[Lỗi dịch: {e}]", (t1 - t0) * 1000.0
