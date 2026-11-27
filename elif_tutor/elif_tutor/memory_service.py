from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import frappe
    from frappe.utils import now_datetime
except ImportError:
    frappe = None
    from datetime import datetime
    def now_datetime():
        return datetime.now()


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9çğıöşü]+", " ", (text or "").lower())).strip()


def _append_bullet(existing: str, note: str, max_items: int = 5) -> str:
    note = (note or "").strip()
    if not note:
        return existing or ""
    lines = [ln.strip() for ln in (existing or "").splitlines() if ln.strip()]
    clean_note = note[:140]
    if any(_norm(clean_note) == _norm(ln.lstrip("-• ")) for ln in lines):
        return "\n".join(lines[-max_items:])
    lines.append(f"- {clean_note}")
    return "\n".join(lines[-max_items:])


def _get_memory_store_path(user: str, ext: str = "json") -> Path:
    safe_user = re.sub(r"[^a-zA-Z0-9_.-]+", "_", user or "default")
    if frappe and hasattr(frappe, "get_site_path"):
        try:
            return Path(frappe.get_site_path("private", "files", f"autonomous_memory_{safe_user}.{ext}"))
        except Exception:
            pass
    return Path(tempfile.gettempdir()) / f"autonomous_memory_{safe_user}.{ext}"


def _load_autonomous_store(user: str) -> Dict[str, Any]:
    p = _get_memory_store_path(user, "json")
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_autonomous_store(user: str, store: Dict[str, Any]) -> None:
    p = _get_memory_store_path(user, "json")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _sync_markdown_journal(user: str) -> None:
    """Kullanıcının hem akademik hem de otonom hafızasını okunabilir Markdown günlüğünde güncel tutar."""
    try:
        rows = []
        if frappe and hasattr(frappe, "get_all"):
            rows = frappe.get_all(
                "Student Learning Memory",
                filters={"owner_user": user},
                fields=["subject", "topic", "mastery_status", "solved_count", "mistake_count", "struggle_notes", "strength_notes", "last_practiced"],
                order_by="last_practiced desc",
                limit=40,
            )
        safe_user = re.sub(r"[^a-zA-Z0-9_.-]+", "_", user)
        if frappe and hasattr(frappe, "get_site_path"):
            try:
                out_path = Path(frappe.get_site_path("private", "files", f"learning_memory_{safe_user}.md"))
            except Exception:
                out_path = Path(tempfile.gettempdir()) / f"learning_memory_{safe_user}.md"
        else:
            out_path = Path(tempfile.gettempdir()) / f"learning_memory_{safe_user}.md"
        out_path.parent.mkdir(parents=True, exist_ok=True)

        md_lines = [f"# Uzun Dönem Öğrenme Hafızası ({user})", ""]

        # Otonom Model Hafızası Bölümü
        auto_store = _load_autonomous_store(user)
        if auto_store:
            md_lines.append("## Öğretmenin Özel Gözlem ve Profil Notları")
            for k, item in auto_store.items():
                cat = item.get("category", "genel")
                val = item.get("value", "")
                reason = item.get("reason", "")
                md_lines.append(f"- **[{cat.upper()}] {k}**: {val}" + (f" *(Gerekçe: {reason})*" if reason else ""))
            md_lines.append("")

        # Akademik Konu Geçmişi
        md_lines.append("## Akademik Konu Durumu")
        for r in rows:
            md_lines.append(f"### {r.subject} — {r.topic} ({r.mastery_status})")
            md_lines.append(f"- Doğru: {r.solved_count} | Takılma: {r.mistake_count} | Son Çalışma: {r.last_practiced}")
            if r.struggle_notes:
                md_lines.append(f"- Takıldığı: {r.struggle_notes}")
            if r.strength_notes:
                md_lines.append(f"- Güçlü: {r.strength_notes}")
            md_lines.append("")

        out_path.write_text("\n".join(md_lines), encoding="utf-8")
    except Exception:
        pass


def store_student_memory(
    user: str,
    key: str,
    value: str,
    category: str = "genel",
    reason: str = "",
) -> None:
    """Kalıcı anahtar-değer öğrenci hafıza saklama."""
    if not user or user == "Guest" or not key:
        return
    clean_key = _norm(key).replace(" ", "_")
    store = _load_autonomous_store(user)
    store[clean_key] = {
        "key": clean_key,
        "value": (value or "").strip()[:500],
        "category": category,
        "reason": (reason or "").strip()[:200],
        "updated_at": str(now_datetime()),
    }
    _save_autonomous_store(user, store)
    _sync_markdown_journal(user)


def retrieve_student_memory(user: str, key: str) -> Optional[Dict[str, Any]]:
    """Tekil bir anıyı anahtarıyla getirir."""
    store = _load_autonomous_store(user)
    clean_key = _norm(key).replace(" ", "_")
    return store.get(clean_key)


def search_student_memories(user: str, pattern: str) -> List[Dict[str, Any]]:
    """Hafıza arama katmanı: Anahtar veya değer içinde eşleşme arar."""
    store = _load_autonomous_store(user)
    p_norm = _norm(pattern)
    results = []
    for item in store.values():
        if p_norm in _norm(item.get("key", "")) or p_norm in _norm(item.get("value", "")) or p_norm in _norm(item.get("category", "")):
            results.append(item)
    return results


def apply_autonomous_memory_actions(
    user: str,
    actions: List[Dict[str, Any]],
    default_subject: str = "Genel",
) -> int:
    """
    Modelin kendi inisiyatifiyle ürettiği memory_actions komutlarını uygular:
    - action: 'set' | 'update' | 'delete'
    - key: 'ogrenci:hayal' | 'akademik:kesirler' vs.
    - value: Bilgi metni
    - reason: Neden kaydettiği
    """
    if not user or user == "Guest" or not actions:
        return 0

    applied_count = 0
    store = _load_autonomous_store(user)

    for act in actions:
        if not isinstance(act, dict):
            continue
        op = str(act.get("action", "set")).lower()
        key = str(act.get("key", "")).strip()
        val = str(act.get("value", "")).strip()
        reason = str(act.get("reason", "")).strip()
        category = str(act.get("category", "ogrenci")).strip()

        if not key:
            continue
        clean_key = _norm(key).replace(" ", "_")

        if op in ("set", "update"):
            store[clean_key] = {
                "key": clean_key,
                "value": val[:500],
                "category": category,
                "reason": reason[:200],
                "updated_at": str(now_datetime()),
            }
            applied_count += 1
        elif op == "delete":
            if clean_key in store:
                del store[clean_key]
                applied_count += 1

    if applied_count > 0:
        _save_autonomous_store(user, store)
        _sync_markdown_journal(user)

    return applied_count


def recall_pedagogical_memories(
    user: str,
    subject: str,
    topic: str = "",
    query_text: str = "",
    limit: int = 4,
) -> Dict[str, Any]:
    """
    Öğrenci Profil ve Hafıza Çağırma Katmanı:
    Modele gidecek sistem prompt'u için hem akademik ders özetini hem de öğrencinin
    otonom profil kartından en alakalı notları (ilgi alanı, zaafı, ajandası) süzüp döndürür.
    """
    if not user or user == "Guest":
        return {"academic": [], "profile_notes": []}

    # 1. Akademik Konu Hatırlama
    academic = get_relevant_long_term_memory(user, subject, topic, query_text, limit=2)

    # 2. Otonom Profil ve Özel Anıları Hatırlama
    store = _load_autonomous_store(user)
    profile_notes: List[Dict[str, str]] = []

    q_words = set(_norm(f"{subject} {topic} {query_text}").split())

    for item in store.values():
        val = item.get("value", "")
        cat = item.get("category", "")
        key = item.get("key", "")
        i_words = set(_norm(f"{key} {val} {cat}").split())

        # Yüksek öncelikli kategoriler (ilgi alanı, sınav, zayıf nokta her zaman hatırda tutulmalı)
        is_priority = any(p in key for p in ["ilgi", "hayal", "sinav", "ajanda", "zaaf", "stil"])
        relevance = len(q_words & i_words)

        if is_priority or relevance > 0:
            profile_notes.append({
                "etiket": item.get("key", ""),
                "kategori": cat,
                "bilgi": val,
            })

    # En fazla limit kadar seç
    return {
        "academic": academic,
        "profile_notes": profile_notes[:limit],
    }


def record_learning_memory(
    user: str,
    subject: str,
    topic: str,
    solved_delta: int = 0,
    mistake_delta: int = 0,
    struggle_note: str = "",
    strength_note: str = "",
) -> None:
    """Ders/konu bazlı uzun dönem öğrenme özetini günceller (cross-session hafıza)."""
    topic = (topic or subject or "").strip()[:80]
    if not topic or not user or user == "Guest":
        return

    if not frappe or not hasattr(frappe, "db"):
        _sync_markdown_journal(user)
        return

    existing = frappe.db.get_value(
        "Student Learning Memory",
        {"owner_user": user, "subject": subject, "topic": topic},
        "name",
    )
    if existing:
        doc = frappe.get_doc("Student Learning Memory", existing)
    else:
        doc = frappe.get_doc({
            "doctype": "Student Learning Memory",
            "owner_user": user,
            "subject": subject,
            "topic": topic,
            "solved_count": 0,
            "mistake_count": 0,
            "struggle_notes": "",
            "strength_notes": "",
        })

    doc.solved_count = int(doc.solved_count or 0) + max(0, int(solved_delta))
    doc.mistake_count = int(doc.mistake_count or 0) + max(0, int(mistake_delta))
    if struggle_note:
        doc.struggle_notes = _append_bullet(doc.struggle_notes, struggle_note)
    if strength_note:
        doc.strength_notes = _append_bullet(doc.strength_notes, strength_note)
    doc.last_practiced = now_datetime()

    if existing:
        doc.save(ignore_permissions=True)
    else:
        doc.insert(ignore_permissions=True)
    _sync_markdown_journal(user)


def get_relevant_long_term_memory(user: str, subject: str, topic: str = "", query_text: str = "", limit: int = 2) -> List[Dict[str, Any]]:
    """Ders ve konuya en alakalı akademik özetleri döndürür."""
    if not user or user == "Guest" or not frappe or not hasattr(frappe, "get_all"):
        return []
    rows = frappe.get_all(
        "Student Learning Memory",
        filters={"owner_user": user, "subject": subject},
        fields=["subject", "topic", "mastery_status", "solved_count", "mistake_count", "struggle_notes", "strength_notes", "last_practiced"],
        order_by="last_practiced desc",
        limit=25,
    )
    if not rows:
        return []

    q_words = set(_norm(f"{topic} {query_text}").split())
    scored = []
    for r in rows:
        t_words = set(_norm(f"{r.topic} {r.struggle_notes or ''}").split())
        overlap = len(q_words & t_words)
        exact = 3 if topic and _norm(topic) == _norm(r.topic) else 0
        score = exact + overlap + (0.5 if r.mastery_status == "needs_review" else 0)
        if score >= 1 or (not topic and r.mastery_status == "needs_review"):
            scored.append((score, r))

    scored.sort(key=lambda x: x[0], reverse=True)
    result = []
    for _, r in scored[:limit]:
        result.append({
            "konu": r.topic,
            "durum": r.mastery_status,
            "dogru": int(r.solved_count or 0),
            "takilma": int(r.mistake_count or 0),
            "onceki_takildigi_noktalar": (r.struggle_notes or "").strip(),
            "guclu_noktalar": (r.strength_notes or "").strip(),
        })
    return result


def list_learning_memories(user: str, limit: int = 30) -> List[Dict[str, Any]]:
    """Tüm hafıza kayıtlarını (akademik + otonom profil) listeler."""
    if not user or user == "Guest":
        return []
    rows = []
    if frappe and hasattr(frappe, "get_all"):
        rows = frappe.get_all(
            "Student Learning Memory",
            filters={"owner_user": user},
            fields=["subject", "topic", "mastery_status", "solved_count", "mistake_count", "struggle_notes", "strength_notes", "last_practiced"],
            order_by="last_practiced desc",
            limit=limit,
        )

    academic_list = [
        {
            "subject": r.subject,
            "topic": r.topic,
            "mastery_status": r.mastery_status,
            "solved_count": int(r.solved_count or 0),
            "mistake_count": int(r.mistake_count or 0),
            "struggle_notes": r.struggle_notes or "",
            "strength_notes": r.strength_notes or "",
            "last_practiced": str(r.last_practiced or ""),
        }
        for r in rows
    ]

    auto_store = _load_autonomous_store(user)
    autonomous_list = list(auto_store.values())

    return {
        "academic": academic_list,
        "autonomous_profile": autonomous_list,
    }
