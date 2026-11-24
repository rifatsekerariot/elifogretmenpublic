from frappe.model.document import Document
from frappe.utils import now_datetime


class StudentLearningMemory(Document):
    def validate(self):
        if not self.last_practiced:
            self.last_practiced = now_datetime()
        sc = int(self.solved_count or 0)
        mc = int(self.mistake_count or 0)
        if sc >= 3 and mc == 0:
            self.mastery_status = "mastered"
        elif mc > sc:
            self.mastery_status = "needs_review"
        elif sc >= 3 and sc >= mc * 2:
            self.mastery_status = "mastered"
        else:
            self.mastery_status = "learning"
