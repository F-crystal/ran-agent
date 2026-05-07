# HEARTBEAT

Project scope: this repository only.

tasks:

- name: waking-self-check
  interval: 30m
  prompt: "Run a lightweight self-check: runtime health, pending failures, and blocked loops. If there is risk, send one concise alert with suggested next step."
- name: todo-tracking-loop
  interval: 20m
  prompt: "Time-aware todo tracking: review open todos/reminders in memory, detect due-soon/overdue items, then send one short reminder or one short follow-up question when details are missing."
- name: proactive-checkin
  interval: 2h
  prompt: "If no important todo is due and user has been quiet, send at most one low-pressure proactive check-in. If user is likely busy or sleeping, stay quiet."

Behavior contract (MVP):

- Fixed loop applies only in waking hours configured by OpenClaw heartbeat `activeHours`.
- When user declares a task/plan/deadline, create or update a todo record via memory tools immediately.
- When user gives an exact time/date, create a reminder (prefer cron/system-event wake) and keep tracking in todo until done.
- If time/task details are incomplete, ask one concise follow-up question, not a multi-question survey.
- Keep reminders concise and non-spammy; if no action needed, return `HEARTBEAT_OK`.
