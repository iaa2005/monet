"""
Rewrite every mirror's card from what is actually in it.

The first cards were written before the copies existed and all said the
same thing — "only the files the application downloads are here". For the
OCR readers that turned out to be false: their file patterns took every
graph, so those mirrors are complete copies. A card that is wrong about
something checkable is a card nobody should trust about the licence
either, so this counts the files on both sides and says which it is.

Cheap and idempotent — it uploads one small file per repo.

    HF_TOKEN=... python scripts/refresh_cards.py
"""

from __future__ import annotations

import os

from huggingface_hub import HfApi

from mirror import MODELS, OWNER, card_for, licence_of


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    hub = HfApi(token=token)

    for model in MODELS:
        target = f"{OWNER}/{model['repo'].split('/')[-1]}"
        try:
            mine = hub.model_info(target)
        except Exception as err:
            print(f"skip {target}: {type(err).__name__}")
            continue
        # Count the same things on both sides. The card is the mirror's
        # own and .gitattributes is the Hub's, so counting them upstream
        # and not downstream made a complete copy report as 38 of 40.
        housekeeping = ("README.md", ".gitattributes")
        upstream = len(
            [
                s
                for s in hub.model_info(model["repo"]).siblings
                if s.rfilename not in housekeeping
            ]
        )
        copied = len(
            [s for s in mine.siblings if s.rfilename not in housekeeping]
        )
        licence, _, _ = licence_of(hub, model)
        card = card_for(model, licence, copied, upstream)
        hub.upload_file(
            path_or_fileobj=card.encode("utf-8"),
            path_in_repo="README.md",
            repo_id=target,
            commit_message="Card: say what was actually copied",
        )
        print(f"{copied:3d}/{upstream:3d} files  {target}")


if __name__ == "__main__":
    main()
