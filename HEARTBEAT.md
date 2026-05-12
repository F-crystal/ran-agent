# HEARTBEAT

Project scope: this repository only.

tasks:

- name: waking-self-check
  interval: 30m
  prompt: "Run a lightweight self-check: runtime health, pending failures, and blocked loops. Do not send proactive alerts or check-ins; if there is risk, keep it internal unless the user explicitly asks."
- name: todo-tracking-loop
  interval: 20m
  prompt: "Time-aware todo tracking: review open todos/reminders in memory and detect due-soon/overdue items. Do not send reminders or follow-up questions unless the user explicitly asks in the current interaction."

Behavior contract (MVP):

- Fixed loop applies only in waking hours configured by OpenClaw heartbeat `activeHours`.
- When user declares a task/plan/deadline, create or update a todo record via memory tools immediately.
- When user gives an exact time/date, create a reminder (prefer cron/system-event wake) and keep tracking in todo until done.
- Heartbeat runs are internal maintenance only. Do not initiate proactive check-ins, reminders, alerts, or follow-up questions from heartbeat.
- If no action needed, return `HEARTBEAT_OK`.
