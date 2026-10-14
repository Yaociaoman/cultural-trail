"""粗略判斷回覆的語言（用來檢查模型是否用錯語言）。"""
import re

_KANA = re.compile(r"[぀-ヿ]")
_CJK = re.compile(r"[一-鿿]")
_LATIN = re.compile(r"[A-Za-z]")


def script_of(text: str) -> str:
    """回傳 'ja'（有假名）、'zh'（以漢字為主）或 'latin'（英文、德文）。"""
    if _KANA.search(text):
        return "ja"
    # 地名保留中文是允許的，所以漢字要明顯多於拉丁字母才算中文
    cjk, latin = len(_CJK.findall(text)), len(_LATIN.findall(text))
    return "zh" if cjk * 2 > latin else "latin"


EXPECTED_SCRIPT = {"zh-TW": "zh", "ja": "ja", "en": "latin", "de": "latin"}


def wrong_language(text: str, lang: str) -> bool:
    return bool(text.strip()) and script_of(text) != EXPECTED_SCRIPT.get(lang, "zh")
