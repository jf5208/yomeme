from dotenv import load_dotenv

from pet_meme.app import create_app


def main() -> None:
    load_dotenv()
    app = create_app()
    print("Pet Meme MVP: http://127.0.0.1:18806")
    app.run(host="127.0.0.1", port=18806, debug=False)


if __name__ == "__main__":
    main()
