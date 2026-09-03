import os
from pathlib import Path
from dotenv import load_dotenv

from pet_meme.app import create_app


def main() -> None:
    # 明确指定 .env 文件路径，确保在任何工作目录下都能正确加载
    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(env_path)
    app = create_app()
    port = int(os.environ.get("PORT", 5000))
    print(f"Pet Meme MVP: http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
