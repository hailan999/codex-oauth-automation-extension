#!/usr/bin/env python3
import argparse
import re
from pathlib import Path


LINK_BLOCK_PATTERN = re.compile(r"----https://xpgmail\.com/s/[^-\s]+")


def remove_link_blocks(text: str) -> str:
    return LINK_BLOCK_PATTERN.sub("", text)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove xpgmail link blocks from each line and write a new file."
    )
    parser.add_argument("input", help="Input text file path")
    parser.add_argument(
        "-o",
        "--output",
        help="Output text file path. Defaults to '<input>.cleaned.txt'.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output) if args.output else input_path.with_suffix(input_path.suffix + ".cleaned.txt")

    text = input_path.read_text(encoding="utf-8")
    output_path.write_text(remove_link_blocks(text), encoding="utf-8")

    print(f"Done: {output_path}")


if __name__ == "__main__":
    main()
