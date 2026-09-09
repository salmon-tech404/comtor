"""
Google Meet JA-VI Translation Service - Setup & Model Downloader
1. Kiểm tra môi trường phần cứng: GPU NVIDIA RTX 4060 vs CPU
2. Cài đặt các thư viện phụ thuộc theo requirements.txt
3. Tải mô hình NLLB-200 CTranslate2 đã convert sẵn từ Hugging Face về thư mục models/
4. Tải Tokenizer SentencePiece đồng bộ để chạy offline 100%
5. Hướng dẫn nạp extension vào Chrome Developer Mode
"""

import sys
import os
import subprocess
import shutil

MODEL_DIR = "models/nllb-200-600M-ct2"
HF_MODEL_REPO = "entai2965/nllb-200-distilled-600M-ctranslate2"
TOKENIZER_REPO = "facebook/nllb-200-distilled-600M"


def print_banner(title: str):
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


def check_python():
    print_banner("1. KIỂM TRA MÔI TRƯỜNG PYTHON")
    ver = sys.version_info
    print(f"Phiên bản Python hiện tại: {ver.major}.{ver.minor}.{ver.micro}")
    if ver.major < 3 or (ver.major == 3 and ver.minor < 9):
        print("❌ LỖI: Cần Python 3.9 trở lên!")
        sys.exit(1)
    print("✅ Phiên bản Python hợp lệ.")


def check_gpu():
    print_banner("2. KIỂM TRA PHẦN CỨNG GPU NVIDIA (CUDA)")
    has_gpu = False
    try:
        res = subprocess.run(["nvidia-smi"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode == 0:
            print("✅ Phát hiện NVIDIA GPU qua nvidia-smi:")
            for line in res.stdout.splitlines():
                if "GeForce" in line or "RTX" in line or "NVIDIA" in line:
                    print(f"   -> {line.strip()}")
            has_gpu = True
        else:
            print("⚠️ Không tìm thấy nvidia-smi. Hệ thống sẽ sử dụng CPU (int8).")
    except FileNotFoundError:
        print("⚠️ Không tìm thấy nvidia-smi. Hệ thống sẽ sử dụng CPU (int8).")

    return has_gpu


def install_requirements():
    print_banner("3. CÀI ĐẶT CÁC THƯ VIỆN PYTHON (requirements.txt)")
    cmd = [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]
    print("Đang cài đặt thư viện, vui lòng đợi giây lát...")
    res = subprocess.run(cmd)
    if res.returncode != 0:
        print("❌ Lỗi cài đặt thư viện!")
        sys.exit(1)
    print("✅ Đã cài đặt đầy đủ thư viện.")


def download_model():
    print_banner("4. TẢI MÔ HÌNH NLLB-200 CTRANSLATE2")
    os.makedirs(MODEL_DIR, exist_ok=True)

    # Kiểm tra nếu model đã tồn tại
    expected_bin = os.path.join(MODEL_DIR, "model.bin")
    if os.path.exists(expected_bin):
        print(f"✅ Mô hình đã có sẵn tại '{MODEL_DIR}' ({os.path.getsize(expected_bin) // (1024*1024)} MB). Bỏ qua tải lại.")
        return

    print(f"Đang tải mô hình CTranslate2 từ HuggingFace '{HF_MODEL_REPO}'...")
    print("Mô hình dung lượng khoảng ~600MB - 1.2GB, quá trình tải sẽ tự động hiển thị thanh tiến trình:")

    try:
        from huggingface_hub import snapshot_download
        from transformers import AutoTokenizer

        # 1. Tải trọng số model CTranslate2
        snapshot_download(
            repo_id=HF_MODEL_REPO,
            local_dir=MODEL_DIR,
            local_dir_use_symlinks=False
        )
        print("✅ Tải trọng số mô hình CTranslate2 hoàn tất.")

        # 2. Tải tokenizer và lưu vào cùng thư mục model để offline hoàn toàn
        print(f"Đang tải Tokenizer từ '{TOKENIZER_REPO}'...")
        tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_REPO, src_lang="jpn_Jpan")
        tokenizer.save_pretrained(MODEL_DIR)
        print("✅ Đã lưu Tokenizer vào thư mục mô hình.")

    except Exception as e:
        print(f"❌ Lỗi khi tải mô hình: {e}")
        print("Bạn cũng có thể tải thủ công hoặc convert từ facebook/nllb-200-distilled-600M bằng lệnh:")
        print("ct2-transformers-converter --model facebook/nllb-200-distilled-600M --output_dir models/nllb-200-600M-ct2 --quantization float16")
        sys.exit(1)


def print_chrome_instructions():
    print_banner("5. HƯỚNG DẪN NẠP CHROME EXTENSION")
    ext_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "extension"))
    print(f"""
👉 Bước 1: Mở trình duyệt Google Chrome, truy cập đường dẫn:
   chrome://extensions/

👉 Bước 2: Bật công tắc "Developer mode" (Chế độ cho nhà phát triển) ở góc trên bên phải.

👉 Bước 3: Nhấp vào nút "Load unpacked" (Tải tiện ích đã giải nén).

👉 Bước 4: Chọn thư mục sau:
   {ext_path}

👉 Bước 5: Mở tab Google Meet, tham gia cuộc họp, bật phụ đề CC tiếng Nhật.
   Phụ đề tiếng Việt song song sẽ xuất hiện trên màn hình!
""")


def main():
    print("\n" + "#" * 60)
    print("#  BỘ CÀI ĐẶT DỊCH VỤ DỊCH GOOGLE MEET NHẬT - VIỆT REAL-TIME  #")
    print("#" * 60)

    check_python()
    has_gpu = check_gpu()
    install_requirements()
    download_model()
    print_chrome_instructions()

    print_banner("CÀI ĐẶT HOÀN TẤT!")
    print("Khởi động server dịch vụ bằng cách chạy file: run_service.bat")
    print("Hoặc gõ lệnh: python main.py\n")


if __name__ == "__main__":
    main()
