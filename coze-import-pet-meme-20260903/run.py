import os
from dotenv import load_dotenv

from pet_meme.app import create_app


def main() -> None:
    load_dotenv()
    app = create_app()
    port = int(os.environ.get("PORT", 5000))
    print(f"Pet Meme MVP: http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
