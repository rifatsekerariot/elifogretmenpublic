from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


def compute_time_grade(total_q: int, solved_q: int, duration_seconds: int, total_attempts: int = 0):
    if total_q <= 0:
        return 0, "Henüz Başlanmadı"
    if solved_q == 0:
        return 0, "Devam Ediyor"

    completion_ratio = solved_q / total_q
    avg_sec = max(1, duration_seconds) / max(1, solved_q)
    if avg_sec <= 270:
        pace_pts = 50
    elif avg_sec <= 420:
        pace_pts = 44
    elif avg_sec <= 600:
        pace_pts = 37
    else:
        pace_pts = 28

    completion_pts = round(completion_ratio * 40)
    avg_attempts = total_attempts / max(1, solved_q)
    focus_pts = 10 if avg_attempts <= 2.5 else (8 if avg_attempts <= 4 else 6)

    score = min(100, max(10, pace_pts + completion_pts + focus_pts))
    if score >= 90:
        grade = f"A+ ({score}/100 • Süper Tempo!)"
    elif score >= 80:
        grade = f"A ({score}/100 • Çok İyi)"
    elif score >= 70:
        grade = f"B ({score}/100 • İyi)"
    elif score >= 60:
        grade = f"C ({score}/100 • Geliştirilebilir)"
    else:
        grade = f"D ({score}/100 • Daha Odaklı Çalışalım)"
    return score, grade


class HomeworkSheet(Document):
    def validate(self):
        if not self.started_at:
            self.started_at = now_datetime()
        if not self.owner_user:
            self.owner_user = frappe.session.user

        rows = self.questions or []
        self.total_questions = len(rows)
        self.solved_questions = sum(1 for r in rows if r.status == "solved")
        total_attempts = sum(int(r.attempts or 0) for r in rows)
        items_dur = sum(int(r.duration_seconds or 0) for r in rows)
        self.duration_seconds = max(int(self.duration_seconds or 0), items_dur)

        score, grade = compute_time_grade(
            self.total_questions,
            self.solved_questions,
            self.duration_seconds,
            total_attempts,
        )
        self.time_score = score
        self.time_grade = grade

        if self.total_questions > 0 and self.solved_questions >= self.total_questions:
            self.status = "completed"
            if not self.completed_at:
                self.completed_at = now_datetime()
        else:
            self.status = "in_progress"
